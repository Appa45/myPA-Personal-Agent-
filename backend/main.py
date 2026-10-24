import json
import logging
import os
import re
import sqlite3
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

# Initialize paths and environment before importing project services.
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))
load_dotenv(BASE_DIR / ".env", override=True)

from email_service import send_email
from firebase_service import send_push_notification
from location_service import get_location
from reminder_parser import parse_reminder_command
import assistant as core

from apscheduler.jobstores.base import JobLookupError
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger


app = FastAPI(title="AURA Assistant API")

# Persistent storage for contacts and user-saved email drafts. Kept separate
# from APScheduler's job-store tables to avoid coupling CRUD data to the scheduler.
DATA_DB_PATH = BASE_DIR / "aura_data.sqlite"


@contextmanager
def get_data_db():
    connection = sqlite3.connect(DATA_DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_data_db() -> None:
    with get_data_db() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        connection.execute("CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name)")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS email_drafts (
                id TEXT PRIMARY KEY,
                recipient TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                instruction TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        connection.execute("CREATE INDEX IF NOT EXISTS idx_email_drafts_updated ON email_drafts(updated_at)")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS reminder_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                fired_at TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT ''
            )
        """)
        connection.execute("CREATE INDEX IF NOT EXISTS idx_reminder_events_fired_at ON reminder_events(fired_at)")


initialize_data_db()

try:
    LOCAL_TIMEZONE = ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Kolkata"))
except (ZoneInfoNotFoundError, ValueError):
    logging.exception("Invalid APP_TIMEZONE; falling back to Asia/Kolkata")
    LOCAL_TIMEZONE = ZoneInfo("Asia/Kolkata")


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

origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[item.strip() for item in origins if item.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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


class EmailDraftRequest(BaseModel):
    instruction: str = Field(min_length=3, max_length=2000)


class ScheduledEmailRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=10000)
    send_at: datetime

    @field_validator("subject", "body")
    @classmethod
    def strip_email_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class ContactCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    phone: str = Field(default="", max_length=30)
    notes: str = Field(default="", max_length=1000)

    @field_validator("name", "email", "phone", "notes")
    @classmethod
    def strip_contact_fields(cls, value: str) -> str:
        return value.strip()

    @field_validator("name")
    @classmethod
    def require_contact_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Contact name cannot be empty.")
        return value.strip()

    @field_validator("email")
    @classmethod
    def validate_contact_email(cls, value: str) -> str:
        value = value.strip().lower()
        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Enter a valid email address.")
        local, _, domain = value.partition("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Enter a valid email address.")
        return value


class ContactUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    email: Optional[str] = Field(default=None, min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=30)
    notes: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("name", "email", "phone", "notes")
    @classmethod
    def strip_optional_contact_fields(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if value is not None else None

    @field_validator("email")
    @classmethod
    def validate_optional_contact_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip().lower()
        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Enter a valid email address.")
        local, _, domain = value.partition("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Enter a valid email address.")
        return value


class SavedEmailDraftRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=10000)
    instruction: str = Field(default="", max_length=2000)
    recipient: Optional[str] = Field(default=None, max_length=254)

    @field_validator("subject", "body")
    @classmethod
    def require_saved_draft_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Subject and body cannot be empty.")
        return value

    @field_validator("instruction")
    @classmethod
    def strip_saved_draft_instruction(cls, value: str) -> str:
        return value.strip()

    @field_validator("recipient")
    @classmethod
    def validate_saved_draft_recipient(cls, value: Optional[str]) -> Optional[str]:
        if value is None or not value.strip():
            return None
        value = value.strip().lower()
        if value.count("@") != 1 or any(c.isspace() for c in value):
            raise ValueError("Enter a valid recipient email address.")
        local, _, domain = value.partition("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Enter a valid recipient email address.")
        return value


class TestNotificationRequest(BaseModel):
    token: str = Field(min_length=1, max_length=4096)
    title: str = Field(
        default="AURA Test Notification", min_length=1, max_length=200
    )
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
    body: str = Field(
        default="Your scheduled reminder is due.",
        min_length=1,
        max_length=2000,
    )
    url: str = Field(default="/", max_length=2048)

    @field_validator("title", "body")
    @classmethod
    def strip_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class ReminderUpdateRequest(BaseModel):
    # Fields are optional: clients can update only what has changed.
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    due_at: Optional[datetime] = None
    token: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    body: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    url: Optional[str] = Field(default=None, max_length=2048)

    @field_validator("title", "body")
    @classmethod
    def strip_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class ReminderPreviewRequest(BaseModel):
    command: str = Field(min_length=1, max_length=1000)
    timezone: str = Field(default="Asia/Kolkata", min_length=1, max_length=100)
    token: Optional[str] = Field(default=None, max_length=4096)


class ContactEmailRequest(BaseModel):
    contact_name: str = Field(min_length=1, max_length=100)
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=10000)
    confirmed: bool = False

    @field_validator("contact_name", "subject", "body")
    @classmethod
    def strip_contact_email_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class ContactEmailDraftRequest(BaseModel):
    contact_name: str = Field(min_length=1, max_length=100)
    instruction: str = Field(min_length=3, max_length=2000)

    @field_validator("contact_name", "instruction")
    @classmethod
    def strip_contact_email_draft_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class AllContactsEmailRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=10000)
    confirmed: bool = False

    @field_validator("subject", "body")
    @classmethod
    def strip_all_contacts_email_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Subject and body cannot be empty.")
        return value

# -------------------- Time and scheduler helpers --------------------

def normalize_due_at(value: datetime, timezone: ZoneInfo = LOCAL_TIMEZONE) -> datetime:
    """Interpret naive datetime values in the selected timezone."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone)
    return value.astimezone(timezone)


def deliver_reminder(title: str, body: str, token: str, url: str) -> None:
    """Record a fired reminder and attempt its FCM notification."""
    try:
        fired_at = datetime.now(LOCAL_TIMEZONE).isoformat()
        with get_data_db() as connection:
            connection.execute(
                "INSERT INTO reminder_events (title, body, fired_at, url) VALUES (?, ?, ?, ?)",
                (title, body, fired_at, url),
            )
    except Exception:
        # Preserve notification delivery even if event-history persistence fails.
        logging.exception("Could not save reminder event: title=%r", title)

    try:
        message_id = send_push_notification(
            token=token,
            title=title,
            body=body,
            url=url,
        )
        logging.info(
            "Reminder push sent: title=%r message_id=%s",
            title,
            message_id,
        )
    except Exception:
        # There is no HTTP request waiting when a scheduled job fires.
        logging.exception("Scheduled reminder push failed: title=%r", title)


# -------------------- Scheduled Email Helpers --------------------

def get_saved_email() -> str:
    """Recipient is configured server-side; never trust a client-supplied address."""
    return os.getenv("AURA_SAVED_EMAIL", "").strip()


def deliver_scheduled_email(to_email: str, subject: str, body: str) -> None:
    """Run by APScheduler at send_at using the existing SMTP email service."""
    try:
        result = send_email(to_email=to_email, subject=subject, body=body)
        logging.info(
            "Scheduled email sent: recipient=%s subject=%r result=%s",
            to_email,
            subject,
            result,
        )
    except Exception:
        # APScheduler runs without an HTTP request waiting for this result.
        logging.exception(
            "Scheduled email delivery failed: recipient=%s subject=%r",
            to_email,
            subject,
        )


def scheduled_email_job_id(email_id: str) -> str:
    return f"aura-email-{email_id}"


# -------------------- Scheduler lifecycle --------------------

@app.on_event("startup")
def start_reminder_scheduler() -> None:
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


# -------------------- Email draft for a saved contact --------------------

def _fallback_email_draft(contact_name: str, instruction: str) -> tuple[str, str]:
    """Build a usable draft from the user's instruction if AI generation fails."""
    text = instruction.strip()

    # Remove common command wrappers while preserving the actual message/details.
    patterns = [
        rf"^\s*(?:please\s+)?(?:send|write|draft|compose|create)\s+(?:an?\s+)?email\s+(?:to\s+)?{re.escape(contact_name)}\s*[,;:]?\s*",
        rf"^\s*(?:please\s+)?(?:send|write|draft|compose|create)\s+(?:an?\s+)?email\s+to\s+{re.escape(contact_name)}\s+",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)

    text = re.sub(r"^\s*(?:saying|that|with the message|message)\s*[:,]?\s*", "", text, flags=re.IGNORECASE).strip()
    text = text.strip(' \"\'.,;:')

    # Avoid producing an empty body if the command was phrased unusually.
    if not text or len(text) < 3:
        text = instruction.strip()

    lower = text.lower()
    if any(word in lower for word in ("meeting", "join", "attend", "call")):
        subject = "Meeting Update"
    elif any(word in lower for word in ("reschedule", "postpone", "change the time")):
        subject = "Meeting Rescheduling Request"
    else:
        subject = "Message"

    body = f"Hi {contact_name},\n\n{text[0].upper() + text[1:] if text else 'I wanted to share an update.'}\n\nBest regards"
    return subject[:200], body[:10000]


@app.post("/api/email/draft-to-contact")
def draft_email_to_contact(payload: ContactEmailDraftRequest):
    """Resolve a saved contact and prepare an email draft; never sends it."""
    with get_data_db() as connection:
        rows = connection.execute(
            "SELECT id, name, email FROM contacts WHERE LOWER(TRIM(name)) = LOWER(?) ORDER BY name COLLATE NOCASE ASC",
            (payload.contact_name.strip(),),
        ).fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No saved contact found with the name '{payload.contact_name.strip()}'.",
        )
    if len(rows) > 1:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "More than one contact has this name. Choose a specific contact before drafting.",
                "contacts": [
                    {"id": row["id"], "name": row["name"], "email": row["email"]}
                    for row in rows
                ],
            },
        )

    contact = rows[0]
    subject = ""
    body = ""

    # AI drafting is best-effort. A missing/invalid key or malformed AI response
    # must not prevent AURA from returning a reviewable draft.
    if os.getenv("GROQ_API_KEY"):
        prompt = (
            "Write a clear, natural email based only on the user's instruction. "
            "Return ONLY valid JSON with exactly two string keys: subject and body. "
            "Do not include markdown fences. Do not invent facts. Preserve any specific "
            "dates, times, names, and commitments stated by the user.\n\n"
            f"Recipient name: {contact['name']}\n"
            f"User instruction: {payload.instruction.strip()}"
        )
        try:
            generated = core.think(prompt)
            if isinstance(generated, dict):
                parsed = generated
            else:
                raw = str(generated).strip()
                raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
                match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
                if not match:
                    raise ValueError("The AI did not return a JSON email draft.")
                parsed = json.loads(match.group(0))

            subject = str(parsed.get("subject", "")).strip()
            body = str(parsed.get("body", "")).strip()
            if not subject or not body:
                raise ValueError("The AI draft is missing a subject or body.")
        except Exception:
            logging.exception("AI email draft generation failed; using instruction-based fallback")

    if not subject or not body:
        subject, body = _fallback_email_draft(contact["name"], payload.instruction)

    return {
        "success": True,
        "contact_id": contact["id"],
        "contact_name": contact["name"],
        "recipient": contact["email"],
        "subject": subject[:200],
        "body": body[:10000],
        "sent": False,
        "used_fallback": not bool(os.getenv("GROQ_API_KEY")),
        "message": "Email draft prepared. Review it and explicitly confirm before sending.",
    }


# -------------------- Email to saved contacts --------------------

@app.post("/api/email/send-to-contact")
def send_email_to_contact(payload: ContactEmailRequest):
    """Send an email to one uniquely matched saved contact after confirmation."""
    if not payload.confirmed:
        raise HTTPException(
            status_code=400,
            detail="Email not sent. Review the recipient, subject, and body, then confirm sending.",
        )

    contact_name = payload.contact_name.strip()
    with get_data_db() as connection:
        rows = connection.execute(
            """SELECT id, name, email FROM contacts
               WHERE LOWER(TRIM(name)) = LOWER(?)
               ORDER BY name COLLATE NOCASE ASC""",
            (contact_name,),
        ).fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No saved contact found with the name '{contact_name}'.",
        )

    if len(rows) > 1:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "More than one contact has this name. Choose a specific contact before sending.",
                "contacts": [
                    {"id": row["id"], "name": row["name"], "email": row["email"]}
                    for row in rows
                ],
            },
        )

    contact = rows[0]

    # Validate the configured sender before attempting SMTP delivery.
    # This catches missing or stale environment configuration with a clear error.
    gmail_address = os.getenv("GMAIL_ADDRESS", "").strip()
    if (
        not gmail_address
        or gmail_address.count("@") != 1
        or any(character.isspace() for character in gmail_address)
        or "." not in gmail_address.rsplit("@", 1)[-1]
        or gmail_address.rsplit("@", 1)[-1].startswith(".")
        or gmail_address.rsplit("@", 1)[-1].endswith(".")
    ):
        logging.error(
            "GMAIL_ADDRESS is missing or invalid. Check %s/.env",
            BASE_DIR,
        )
        raise HTTPException(
            status_code=503,
            detail=(
                "Email service is not configured correctly. Set GMAIL_ADDRESS "
                "to the full Gmail address in backend/.env, then restart the backend."
            ),
        )

    try:
        service_result = send_email(
            to_email=contact["email"],
            subject=payload.subject,
            body=payload.body,
        )
        return {
            "success": True,
            "sent_count": 1,
            "failed_count": 0,
            "recipients": [
                {
                    "name": contact["name"],
                    "email": contact["email"],
                    "status": "sent",
                }
            ],
            "message": f"Email sent successfully to {contact['name']}.",
            "result": service_result,
        }
    except ValueError as exc:
        # Input/config validation errors should be returned cleanly.
        logging.warning(
            "Email request rejected for contact %s: %s",
            contact["email"],
            str(exc),
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.exception(
            "Email sending failed. Contact=%s, Error=%s",
            contact["email"],
            repr(exc),
        )
        raise HTTPException(
            status_code=502,
            detail=(
                "Email delivery failed. Check GMAIL_ADDRESS, Gmail App Password, "
                "SMTP settings, and backend logs."
            ),
        ) from exc


@app.post("/api/email/send-to-all-contacts")
def send_email_to_all_contacts(payload: AllContactsEmailRequest):
    """Send separate email messages to all saved contacts after explicit confirmation."""
    if not payload.confirmed:
        raise HTTPException(
            status_code=400,
            detail="Emails not sent. Review the message and recipient count, then confirm sending to all contacts.",
        )

    with get_data_db() as connection:
        rows = connection.execute(
            "SELECT id, name, email FROM contacts ORDER BY name COLLATE NOCASE ASC"
        ).fetchall()

    if not rows:
        raise HTTPException(status_code=404, detail="There are no saved contacts to email.")

    sent = []
    failed = []
    # Send individually so each recipient receives only their own address.
    for contact in rows:
        try:
            send_email(
                to_email=contact["email"],
                subject=payload.subject,
                body=payload.body,
            )
            sent.append({"id": contact["id"], "name": contact["name"], "email": contact["email"], "status": "sent"})
        except Exception as exc:
            logging.exception("Bulk contact email failed: %s", contact["email"])
            failed.append({
                "id": contact["id"],
                "name": contact["name"],
                "email": contact["email"],
                "status": "failed",
                "error": str(exc)[:300],
            })

    return {
        "success": len(failed) == 0,
        "sent_count": len(sent),
        "failed_count": len(failed),
        "total_contacts": len(rows),
        "sent": sent,
        "failed": failed,
        "message": f"Email sent to {len(sent)} of {len(rows)} contacts.",
    }


# -------------------- Contacts CRUD API --------------------

@app.get("/api/contacts")
def list_contacts(q: Optional[str] = None):
    """Return saved contacts, optionally filtered by name/email/phone/notes."""
    with get_data_db() as connection:
        if q and q.strip():
            pattern = f"%{q.strip()}%"
            rows = connection.execute(
                """SELECT id, name, email, phone, notes, created_at, updated_at
                   FROM contacts WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR notes LIKE ?
                   ORDER BY name COLLATE NOCASE ASC""",
                (pattern, pattern, pattern, pattern),
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT id, name, email, phone, notes, created_at, updated_at FROM contacts ORDER BY name COLLATE NOCASE ASC"
            ).fetchall()
    return {"contacts": [dict(row) for row in rows]}


@app.post("/api/contacts", status_code=201)
def create_contact(payload: ContactCreateRequest):
    now = datetime.now(LOCAL_TIMEZONE).isoformat()
    contact_id = uuid.uuid4().hex
    try:
        with get_data_db() as connection:
            connection.execute(
                "INSERT INTO contacts (id, name, email, phone, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (contact_id, payload.name, payload.email, payload.phone, payload.notes, now, now),
            )
            row = connection.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
        return {"success": True, "contact": dict(row)}
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Could not create this contact.") from exc
    except Exception as exc:
        logging.exception("Could not create contact")
        raise HTTPException(status_code=500, detail="Could not save contact.") from exc


@app.patch("/api/contacts/{contact_id}")
def update_contact(contact_id: str, payload: ContactUpdateRequest):
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="Provide at least one field to update.")
    changes["updated_at"] = datetime.now(LOCAL_TIMEZONE).isoformat()
    allowed = {"name", "email", "phone", "notes", "updated_at"}
    if any(key not in allowed for key in changes):
        raise HTTPException(status_code=400, detail="Invalid contact field.")
    assignments = ", ".join(f"{key} = ?" for key in changes)
    values = list(changes.values()) + [contact_id]
    with get_data_db() as connection:
        existing = connection.execute("SELECT id FROM contacts WHERE id = ?", (contact_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Contact not found.")
        connection.execute(f"UPDATE contacts SET {assignments} WHERE id = ?", values)
        row = connection.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
    return {"success": True, "contact": dict(row)}


@app.delete("/api/contacts/{contact_id}")
def delete_contact(contact_id: str):
    with get_data_db() as connection:
        cursor = connection.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Contact not found.")
    return {"success": True, "message": "Contact deleted."}


# -------------------- Saved Email Draft CRUD API --------------------

@app.get("/api/email/drafts")
def list_saved_email_drafts():
    with get_data_db() as connection:
        rows = connection.execute(
            "SELECT id, recipient, subject, body, instruction, created_at, updated_at FROM email_drafts ORDER BY updated_at DESC"
        ).fetchall()
    return {"drafts": [dict(row) for row in rows]}


@app.post("/api/email/drafts", status_code=201)
def save_email_draft(payload: SavedEmailDraftRequest):
    draft_id = uuid.uuid4().hex
    now = datetime.now(LOCAL_TIMEZONE).isoformat()
    recipient = payload.recipient or get_saved_email()
    try:
        with get_data_db() as connection:
            connection.execute(
                "INSERT INTO email_drafts (id, recipient, subject, body, instruction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (draft_id, recipient, payload.subject, payload.body, payload.instruction, now, now),
            )
            row = connection.execute("SELECT * FROM email_drafts WHERE id = ?", (draft_id,)).fetchone()
        return {"success": True, "draft": dict(row)}
    except Exception as exc:
        logging.exception("Could not save email draft")
        raise HTTPException(status_code=500, detail="Could not save email draft.") from exc


@app.patch("/api/email/drafts/{draft_id}")
def update_saved_email_draft(draft_id: str, payload: SavedEmailDraftRequest):
    now = datetime.now(LOCAL_TIMEZONE).isoformat()
    recipient = payload.recipient or get_saved_email()
    with get_data_db() as connection:
        existing = connection.execute("SELECT id FROM email_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Saved email draft not found.")
        connection.execute(
            "UPDATE email_drafts SET recipient = ?, subject = ?, body = ?, instruction = ?, updated_at = ? WHERE id = ?",
            (recipient, payload.subject, payload.body, payload.instruction, now, draft_id),
        )
        row = connection.execute("SELECT * FROM email_drafts WHERE id = ?", (draft_id,)).fetchone()
    return {"success": True, "draft": dict(row)}


@app.delete("/api/email/drafts/{draft_id}")
def delete_saved_email_draft(draft_id: str):
    with get_data_db() as connection:
        cursor = connection.execute("DELETE FROM email_drafts WHERE id = ?", (draft_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Saved email draft not found.")
    return {"success": True, "message": "Saved email draft deleted."}


# -------------------- Scheduled Email Drafting and Delivery --------------------

@app.get("/api/email/settings")
def email_settings():
    recipient = get_saved_email()
    return {
        "configured": bool(recipient),
        "recipient": recipient or None,
        "message": (
            "Saved recipient is ready."
            if recipient
            else "Set AURA_SAVED_EMAIL in backend/.env to configure the saved recipient."
        ),
    }


@app.post("/api/email/draft")
def draft_email(payload: EmailDraftRequest):
    """Use AURA's existing AI backend to prepare a draft for review."""
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is missing. Add it to backend/.env and restart the server.",
        )

    recipient = get_saved_email()
    if not recipient:
        raise HTTPException(
            status_code=503,
            detail="No saved recipient is configured. Set AURA_SAVED_EMAIL in backend/.env.",
        )

    prompt = (
        "Write a clear, professional email based on the user's instruction. "
        "Return ONLY valid JSON with exactly two string keys: subject and body. "
        "Do not include markdown fences. Do not invent facts; use concise placeholders "
        "in square brackets for missing details.\n\n"
        f"User instruction: {payload.instruction.strip()}\n"
        f"Recipient email (for context only): {recipient}"
    )
    try:
        generated = core.think(prompt)
        if isinstance(generated, dict):
            parsed = generated
        else:
            raw = str(generated).strip()
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
            match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
            if not match:
                raise ValueError("The AI did not return a JSON email draft.")
            parsed = json.loads(match.group(0))

        subject = str(parsed.get("subject", "")).strip()
        body = str(parsed.get("body", "")).strip()
        if not subject or not body:
            raise ValueError("The AI draft is missing a subject or body.")
        return {
            "success": True,
            "recipient": recipient,
            "subject": subject[:200],
            "body": body[:10000],
        }
    except HTTPException:
        raise
    except Exception as exc:
        logging.exception("Email draft generation failed")
        raise HTTPException(
            status_code=502,
            detail="Could not generate the email draft. Try a more specific instruction.",
        ) from exc


@app.get("/api/email/scheduled")
def list_scheduled_emails():
    """List pending scheduled-email jobs from the persistent APScheduler store."""
    items = []
    for job in scheduler.get_jobs():
        if not job.id.startswith("aura-email-"):
            continue
        try:
            to_email, subject, body = job.args
        except (TypeError, ValueError):
            logging.warning("Skipping malformed scheduled email job %s", job.id)
            continue
        items.append({
            "id": job.id[len("aura-email-"):],
            "recipient": to_email,
            "subject": subject,
            "body": body,
            "send_at": job.next_run_time.isoformat() if job.next_run_time else None,
            "status": "scheduled",
        })
    items.sort(key=lambda item: item["send_at"] or "")
    return {"emails": items}


@app.post("/api/email/scheduled")
def schedule_email(payload: ScheduledEmailRequest):
    recipient = get_saved_email()
    if not recipient:
        raise HTTPException(
            status_code=503,
            detail="No saved recipient is configured. Set AURA_SAVED_EMAIL in backend/.env.",
        )

    send_at = normalize_due_at(payload.send_at)
    if send_at <= datetime.now(LOCAL_TIMEZONE):
        raise HTTPException(status_code=400, detail="Email send time must be in the future.")

    email_id = uuid.uuid4().hex
    job_id = scheduled_email_job_id(email_id)
    try:
        scheduler.add_job(
            deliver_scheduled_email,
            trigger=DateTrigger(run_date=send_at, timezone=LOCAL_TIMEZONE),
            args=[recipient, payload.subject.strip(), payload.body.strip()],
            id=job_id,
            name=payload.subject.strip(),
            replace_existing=False,
            misfire_grace_time=3600,
        )
    except Exception as exc:
        logging.exception("Could not schedule email")
        raise HTTPException(
            status_code=500,
            detail="Could not schedule email. Check scheduler configuration.",
        ) from exc

    return {
        "success": True,
        "id": email_id,
        "recipient": recipient,
        "subject": payload.subject.strip(),
        "send_at": send_at.isoformat(),
        "message": "Email scheduled successfully.",
    }


@app.patch("/api/email/scheduled/{email_id}")
def update_scheduled_email(email_id: str, payload: ScheduledEmailRequest):
    recipient = get_saved_email()
    if not recipient:
        raise HTTPException(status_code=503, detail="AURA_SAVED_EMAIL is not configured.")

    job_id = scheduled_email_job_id(email_id)
    job = scheduler.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Scheduled email not found or already sent.")

    send_at = normalize_due_at(payload.send_at)
    if send_at <= datetime.now(LOCAL_TIMEZONE):
        raise HTTPException(status_code=400, detail="Email send time must be in the future.")

    try:
        scheduler.modify_job(
            job_id,
            trigger=DateTrigger(run_date=send_at, timezone=LOCAL_TIMEZONE),
            args=[recipient, payload.subject.strip(), payload.body.strip()],
            name=payload.subject.strip(),
        )
    except Exception as exc:
        logging.exception("Could not update scheduled email")
        raise HTTPException(status_code=500, detail="Could not update scheduled email.") from exc

    return {"success": True, "message": "Scheduled email updated.", "send_at": send_at.isoformat()}


@app.delete("/api/email/scheduled/{email_id}")
def cancel_scheduled_email(email_id: str):
    job_id = scheduled_email_job_id(email_id)
    try:
        scheduler.remove_job(job_id)
        return {"success": True, "message": "Scheduled email cancelled."}
    except JobLookupError as exc:
        raise HTTPException(status_code=404, detail="Scheduled email not found or already sent.") from exc
    except Exception as exc:
        logging.exception("Could not cancel scheduled email")
        raise HTTPException(status_code=500, detail="Could not cancel scheduled email.") from exc


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


# -------------------- Natural-language reminder preview --------------------


@app.post("/api/reminders/voice/preview")
def preview_voice_reminder(payload: ReminderPreviewRequest):
    """Parse a voice reminder and return a preview without scheduling it."""
    try:
        try:
            timezone = ZoneInfo(payload.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid timezone: {payload.timezone}",
            )

        now = datetime.now(timezone)

        result = parse_reminder_command(
            payload.command,
            now,
        )

        if payload.token:
            result["token"] = payload.token

        return result

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logging.exception("Reminder command parsing failed")
        raise HTTPException(
            status_code=500,
            detail="Could not parse reminder command. Check backend logs.",
        ) from exc

# -------------------- Scheduled Reminders --------------------

@app.post("/api/reminders")
def create_reminder(payload: ReminderRequest):
    """
    Schedule a one-time reminder.
    Send due_at as ISO 8601 with timezone, e.g. 2026-10-22T09:00:00+05:30.
    """
    due_at = normalize_due_at(payload.due_at)
    if due_at <= datetime.now(LOCAL_TIMEZONE):
        raise HTTPException(
            status_code=400,
            detail="Reminder time must be in the future.",
        )

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


@app.get("/api/reminders/events")
def list_reminder_events(after_id: int = 0, limit: int = 200):
    """Return fired reminder events after an ID for frontend polling."""
    after_id = max(0, after_id)
    limit = max(1, min(limit, 500))
    with get_data_db() as connection:
        rows = connection.execute(
            """SELECT id, title, body, fired_at, url
               FROM reminder_events
               WHERE id > ?
               ORDER BY id ASC
               LIMIT ?""",
            (after_id, limit),
        ).fetchall()
        latest = connection.execute(
            "SELECT COALESCE(MAX(id), 0) AS latest_id FROM reminder_events"
        ).fetchone()
    events = [
        {
            "id": row["id"],
            "title": row["title"],
            "body": row["body"],
            "fired_at": row["fired_at"],
            "url": row["url"],
        }
        for row in rows
    ]
    return {"events": events, "latest_id": latest["latest_id"]}


@app.get("/api/reminders")
def list_reminders():
    """Return pending scheduled jobs, not a full reminder history."""
    return {
        "reminders": [
            {
                "id": job.id,
                "title": job.name,
                "due_at": (
                    job.next_run_time.isoformat()
                    if job.next_run_time
                    else None
                ),
            }
            for job in scheduler.get_jobs()
        ]
    }


@app.patch("/api/reminders/{reminder_id}")
def update_reminder(reminder_id: str, payload: ReminderUpdateRequest):
    """Edit reminder details and/or reschedule its one-time delivery."""
    try:
        job = scheduler.get_job(reminder_id)
    except Exception as exc:
        logging.exception("Could not retrieve reminder job")
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve reminder.",
        ) from exc

    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Reminder not found or already triggered.",
        )

    # The existing scheduled function receives [title, body, token, url].
    old_title, old_body, old_token, old_url = job.args
    title = payload.title if payload.title is not None else old_title
    body = payload.body if payload.body is not None else old_body
    token = payload.token if payload.token is not None else old_token
    url = payload.url if payload.url is not None else old_url

    changes = {
        "args": [title, body, token, url],
        "name": title,
    }

    if payload.due_at is not None:
        due_at = normalize_due_at(payload.due_at)
        if due_at <= datetime.now(LOCAL_TIMEZONE):
            raise HTTPException(
                status_code=400,
                detail="Reminder time must be in the future.",
            )
        changes["trigger"] = DateTrigger(
            run_date=due_at,
            timezone=LOCAL_TIMEZONE,
        )

    try:
        scheduler.modify_job(reminder_id, **changes)
        updated_job = scheduler.get_job(reminder_id)
        return {
            "success": True,
            "id": reminder_id,
            "title": updated_job.name if updated_job else title,
            "due_at": (
                updated_job.next_run_time.isoformat()
                if updated_job and updated_job.next_run_time
                else None
            ),
            "message": "Reminder updated successfully.",
        }
    except JobLookupError as exc:
        raise HTTPException(
            status_code=404,
            detail="Reminder not found or already triggered.",
        ) from exc
    except Exception as exc:
        logging.exception("Could not update reminder")
        raise HTTPException(
            status_code=500,
            detail="Could not update reminder. Check the backend logs.",
        ) from exc


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
        raise HTTPException(
            status_code=500,
            detail="Could not cancel reminder.",
        ) from exc


