import os
import sys
from pathlib import Path
from fastapi import FastAPI,HTTPException

from dotenv import load_dotenv

from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from email_service import send_email


app = FastAPI(title="AURA Assistant API")

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR))

import assistant as core  # noqa: E402
from location_service import get_location  # noqa: E402


from pydantic import BaseModel, Field, field_validator


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

        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Enter a valid recipient email address.")

        return value




origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[item.strip() for item in origins if item.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1500)


@app.get("/api/health")
def health():
    return {"ok": True, "configured": bool(os.getenv("GROQ_API_KEY"))}

@app.post("/api/chat")
def chat(payload: ChatRequest):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(status_code=503, detail="GROQ_API_KEY is missing. Add it to backend/.env and restart the server.")
    try:
        return {"reply": core.think(payload.message.strip())}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Assistant request failed: {type(exc).__name__}: {exc}") from exc

@app.get("/api/location")
def location():
    result = get_location()
    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("error", "Location lookup failed"))
    return result





@app.post("/api/email/send")
def send_email_endpoint(payload: EmailRequest):
    try:
        result = send_email(
            to_email=payload.to,
            subject=payload.subject,
            body=payload.body,
        )
        return result

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    except Exception:
        logging.exception("Email sending failed")
        raise HTTPException(
            status_code=502,
            detail="Email could not be sent. Check the backend email configuration and logs.",
        )

