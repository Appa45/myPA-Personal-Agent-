import os
import sys
import sqlite3
import logging
import uuid
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

# Initialize paths and environment before importing services.
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))
load_dotenv(BASE_DIR / ".env")

from email_service import send_email
from firebase_service import send_push_notification
from location_service import get_location
from reminder_parser import DEFAULT_REMINDER_BODY, parse_reminder_command
import assistant as core

from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger
from apscheduler.jobstores.base import JobLookupError


app = FastAPI(title="AURA Assistant API")
LOCAL_TIMEZONE = ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Kolkata"))

# Persist scheduled jobs in a SQLite database beside main.py.
REMINDER_DB_PATH = BASE_DIR / "aura_reminders.sqlite"
scheduler = BackgroundScheduler(
    timezone=LOCAL_TIMEZONE,
    jobstores={
        "default": SQLAlchemyJobStore(
            url=f"sqlite:///{REMINDER_DB_PATH.as_posix()}"
        )
    },
)


# -------------------- CORS --------------------

origins = [
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,"
        "https://frontend-mu-dusky-23.vercel.app",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# -------------------- Request Models --------------------

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1500)


class EmailRequest(BaseModel):
    to: str = Field(min_length=3, max_length=254)
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=10000)

    @field_validator("to")
    @classmethod
    def validate_recipient(cls, value: str) -> str:
        value = value.strip()

        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Enter a valid recipient email address.")

        local, _, domain = value.partition("@")
        if (
            not local
            or "." not in domain
            or domain.startswith(".")
            or domain.endswith(".")
        ):
            raise ValueError("Enter a valid recipient email address.")
        return value


class TestNotificationRequest(BaseModel):
    token: str = Field(min_length=1, max_length=4096)
    title: str = Field(default="AURA Test Notification", min_length=1, max_length=200)
    body: str = Field(
        default="Your Firebase push notification is working!",
        min_length=1,
        max_length=2000,
    )
    url: str = Field(default="/", max_length=2048)


class ReminderRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    due_at: datetime
    token: str = Field(min_length=1, max_length=4096)
    body: str = Field(default=DEFAULT_REMINDER_BODY, min_length=1, max_length=2000)
    url: str = Field(default="/", max_length=2048)

    @field_validator("title", "body")
    @classmethod
    def strip_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class ReminderUpdateRequest(BaseModel):
    """Partial update: send only the fields you want to change."""

    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    due_at: Optional[datetime] = None
    token: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    body: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    url: Optional[str] = Field(default=None, max_length=2048)

    @field_validator("title", "body")
    @classmethod
    def strip_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value

    @model_validator(mode="after")
    def require_at_least_one_field(self):
        if all(
            getattr(self, name) is None
            for name in ("title", "due_at", "token", "body", "url")
        ):
            raise ValueError(
                "Provide at least one field to update: title, due_at, body, url or token."
            )
        return self


class VoicePreviewRequest(BaseModel):
    # The frontend sends "command" (plus optional timezone/token, which are ignored).
    text: str = Field(
        min_length=1,
        max_length=1500,
        validation_alias=AliasChoices("text", "command"),
    )

    @field_validator("text")
    @classmethod
    def strip_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


# -------------------- Scheduler lifecycle and delivery --------------------

# -------------------- Fired-reminder log (shown in the UI) --------------------

def _events_db() -> sqlite3.Connection:
    return sqlite3.connect(REMINDER_DB_PATH.as_posix(), timeout=10)


def init_event_table() -> None:
    with closing(_events_db()) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS reminder_events ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "title TEXT NOT NULL, body TEXT NOT NULL, "
            "fired_at TEXT NOT NULL, status TEXT NOT NULL)"
        )
        conn.commit()


def record_reminder_event(title: str, body: str, status: str) -> None:
    try:
        with closing(_events_db()) as conn:
            conn.execute(
                "INSERT INTO reminder_events (title, body, fired_at, status) VALUES (?, ?, ?, ?)",
                (title, body, datetime.now(LOCAL_TIMEZONE).isoformat(), status),
            )
            conn.commit()
    except Exception:
        logging.exception("Could not record reminder event: title=%r", title)



def deliver_reminder(title: str, body: str, token: str, url: str) -> None:
    """Send an FCM notification when the scheduled job becomes due."""
    try:
        message_id = send_push_notification(
            token=token,
            title=title,
            body=body,
            url=url,
        )
        logging.info("Reminder push sent: title=%r message_id=%s", title, message_id)
        record_reminder_event(title, body, "sent")
    except Exception:
        # A scheduled job has no connected HTTP request to return errors to.
        logging.exception("Scheduled reminder push failed: title=%r", title)
        # Still record it so the UI can show the reminder even if the push failed.
        record_reminder_event(title, body, "push_failed")


def normalize_due_at(due_at: datetime) -> datetime:
    """Convert to local time (naive values are Asia/Kolkata) and require the future."""
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=LOCAL_TIMEZONE)

    due_at = due_at.astimezone(LOCAL_TIMEZONE)
    if due_at <= datetime.now(LOCAL_TIMEZONE):
        raise HTTPException(
            status_code=400,
            detail="Reminder time must be in the future.",
        )
    return due_at


@app.on_event("startup")
def start_reminder_scheduler() -> None:
    init_event_table()
    if not scheduler.running:
        scheduler.start()
        logging.info("AURA reminder scheduler started")


@app.on_event("shutdown")
def stop_reminder_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logging.info("AURA reminder scheduler stopped")


# -------------------- Health Check --------------------

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "configured": bool(os.getenv("GROQ_API_KEY")),
        "scheduler_running": scheduler.running,
    }


# -------------------- AI Chat --------------------

@app.post("/api/chat")
def chat(payload: ChatRequest):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is missing. Add it to backend/.env and restart the server.",
        )

    try:
        return {"reply": core.think(payload.message.strip())}
    except Exception as exc:
        logging.exception("Assistant request failed")
        raise HTTPException(
            status_code=502,
            detail=f"Assistant request failed: {type(exc).__name__}: {exc}",
        ) from exc


# -------------------- Location --------------------

@app.get("/api/location")
def location():
    result = get_location()
    if not result.get("success"):
        raise HTTPException(
            status_code=502,
            detail=result.get("error", "Location lookup failed"),
        )
    return result


# -------------------- Email --------------------

@app.post("/api/email/send")
def send_email_endpoint(payload: EmailRequest):
    try:
        return send_email(
            to_email=payload.to,
            subject=payload.subject,
            body=payload.body,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.exception("Email sending failed")
        raise HTTPException(
            status_code=502,
            detail="Email could not be sent. Check the backend email configuration and logs.",
        ) from exc


# -------------------- Firebase Push Notifications --------------------

@app.post("/api/notifications/test")
def test_notification(payload: TestNotificationRequest):
    try:
        message_id = send_push_notification(
            token=payload.token,
            title=payload.title,
            body=payload.body,
            url=payload.url,
        )
        return {
            "success": True,
            "message": "Push notification sent successfully",
            "messageId": message_id,
        }
    except Exception as exc:
        logging.exception("Firebase push notification failed")
        raise HTTPException(
            status_code=502,
            detail=f"Push notification failed: {type(exc).__name__}: {exc}",
        ) from exc


# -------------------- Scheduled Reminders --------------------

@app.post("/api/reminders")
def create_reminder(payload: ReminderRequest):
    """
    Schedule a one-time reminder.
    Send due_at as ISO 8601 with timezone, e.g. 2026-10-22T09:00:00+05:30.
    """
    due_at = normalize_due_at(payload.due_at)
    reminder_id = f"aura-reminder-{uuid.uuid4().hex}"

    try:
        scheduler.add_job(
            deliver_reminder,
            trigger=DateTrigger(run_date=due_at, timezone=LOCAL_TIMEZONE),
            args=[payload.title, payload.body, payload.token, payload.url],
            id=reminder_id,
            name=payload.title,
            replace_existing=False,
            misfire_grace_time=3600,
        )
    except Exception as exc:
        logging.exception("Could not schedule reminder")
        raise HTTPException(
            status_code=500,
            detail="Could not schedule reminder. Check scheduler configuration.",
        ) from exc

    return {
        "success": True,
        "id": reminder_id,
        "title": payload.title,
        "due_at": due_at.isoformat(),
        "timezone": str(LOCAL_TIMEZONE),
        "message": "Reminder scheduled successfully.",
    }


@app.get("/api/reminders")
def list_reminders():
    """Return pending scheduled jobs. This is not a complete reminder history."""
    return {
        "reminders": [
            {
                "id": job.id,
                "title": job.name,
                "due_at": job.next_run_time.isoformat() if job.next_run_time else None,
            }
            for job in scheduler.get_jobs()
        ]
    }


@app.get("/api/reminders/events")
def reminder_events(after_id: int = 0, limit: int = 50):
    """
    Reminders that have fired, oldest first. The UI polls this with the last id it
    has seen so it can show "Reminder triggered" messages in the chat.
    """
    limit = max(1, min(limit, 200))
    with closing(_events_db()) as conn:
        rows = conn.execute(
            "SELECT id, title, body, fired_at, status FROM reminder_events "
            "WHERE id > ? ORDER BY id ASC LIMIT ?",
            (after_id, limit),
        ).fetchall()
        latest = conn.execute("SELECT COALESCE(MAX(id), 0) FROM reminder_events").fetchone()[0]
    events = [
        {"id": r[0], "title": r[1], "body": r[2], "fired_at": r[3], "status": r[4]}
        for r in rows
    ]
    return {"events": events, "latest_id": events[-1]["id"] if events else latest}


# NOTE: declared before the {reminder_id} routes so the literal path is never
# mistaken for an ID (methods differ today, but this keeps it safe if that changes).
@app.post("/api/reminders/voice/preview")
def preview_voice_reminder(payload: VoicePreviewRequest):
    """
    Parse a natural-language command (e.g. "remind me to call mom tomorrow at 9am")
    and return what would be scheduled. Nothing is created: if the result looks
    right, POST `reminder` (plus the device token) to /api/reminders.
    """
    return parse_reminder_command(payload.text, datetime.now(LOCAL_TIMEZONE))


@app.patch("/api/reminders/{reminder_id}")
def update_reminder(reminder_id: str, payload: ReminderUpdateRequest):
    """
    Edit and/or reschedule a pending reminder. Send only the fields to change:
    title, body, url, token, due_at (ISO 8601; naive values use Asia/Kolkata).
    """
    job = scheduler.get_job(reminder_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Reminder not found or already triggered.",
        )

    try:
        old_title, old_body, old_token, old_url = job.args
    except (TypeError, ValueError) as exc:
        logging.exception("Unexpected job arguments for %s", reminder_id)
        raise HTTPException(
            status_code=500,
            detail="Stored reminder has an unexpected format.",
        ) from exc

    changes = payload.model_dump(exclude_none=True)
    new_title = changes.get("title", old_title)
    new_body = changes.get("body", old_body)
    new_token = changes.get("token", old_token)
    new_url = changes.get("url", old_url)
    new_due_at = normalize_due_at(changes["due_at"]) if "due_at" in changes else None

    try:
        scheduler.modify_job(
            reminder_id,
            args=[new_title, new_body, new_token, new_url],
            name=new_title,
        )
        if new_due_at is not None:
            scheduler.reschedule_job(
                reminder_id,
                trigger=DateTrigger(run_date=new_due_at, timezone=LOCAL_TIMEZONE),
            )
    except JobLookupError as exc:
        # The job fired or was cancelled between the lookup and the update.
        raise HTTPException(
            status_code=404,
            detail="Reminder not found or already triggered.",
        ) from exc
    except Exception as exc:
        logging.exception("Could not update reminder")
        raise HTTPException(status_code=500, detail="Could not update reminder.") from exc

    updated = scheduler.get_job(reminder_id)
    due_iso = (
        updated.next_run_time.isoformat()
        if updated is not None and updated.next_run_time
        else (new_due_at.isoformat() if new_due_at else None)
    )

    return {
        "success": True,
        "id": reminder_id,
        "title": new_title,
        "body": new_body,
        "url": new_url,
        "due_at": due_iso,
        "timezone": str(LOCAL_TIMEZONE),
        "message": "Reminder updated successfully.",
    }


@app.delete("/api/reminders/{reminder_id}")
def cancel_reminder(reminder_id: str):
    try:
        scheduler.remove_job(reminder_id)
        return {"success": True, "message": "Reminder cancelled."}
    except JobLookupError as exc:
        raise HTTPException(
            status_code=404,
            detail="Reminder not found or already triggered.",
        ) from exc
    except Exception as exc:
        logging.exception("Could not cancel reminder")
        raise HTTPException(status_code=500, detail="Could not cancel reminder.") from exc