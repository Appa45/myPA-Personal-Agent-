import os
import re
import smtplib
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path

from dotenv import load_dotenv

# Load the backend's .env explicitly so this service also works when imported
# independently of main.py. Existing process environment values are preserved.
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env", override=True)


def _is_valid_email_address(value: str) -> bool:
    """Perform practical validation for a single email address."""
    if not value or value != value.strip() or any(ch.isspace() for ch in value):
        return False
    if value.count("@") != 1:
        return False

    local, _, domain = value.partition("@")
    if not local or not domain or "." not in domain:
        return False
    if local.startswith(".") or local.endswith(".") or ".." in local:
        return False
    if domain.startswith(".") or domain.endswith(".") or ".." in domain:
        return False

    # Reject display-name forms and common malformed address characters.
    if parseaddr(value)[1] != value:
        return False
    if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
        return False
    return True


def send_email(to_email: str, subject: str, body: str) -> dict:
    """Send a plain-text email using Gmail SMTP with implicit TLS."""

    # Read settings at send time so configuration loaded after module import
    # can still be picked up.
    sender = os.getenv("GMAIL_ADDRESS", "").strip()
    password = os.getenv("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()

    if not sender:
        raise RuntimeError(
            "GMAIL_ADDRESS is missing. Set it to your full Gmail address in backend/.env."
        )
    if not password:
        raise RuntimeError(
            "GMAIL_APP_PASSWORD is missing. Set a Google App Password in backend/.env."
        )

    if not _is_valid_email_address(sender):
        raise RuntimeError(
            "GMAIL_ADDRESS is not a valid email address. Check the value in backend/.env."
        )

    recipient = to_email.strip() if isinstance(to_email, str) else ""
    if not _is_valid_email_address(recipient):
        raise ValueError("Please provide a valid recipient email address.")

    if not isinstance(subject, str) or not subject.strip():
        raise ValueError("Email subject cannot be empty.")

    if not isinstance(body, str) or not body.strip():
        raise ValueError("Email message cannot be empty.")

    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject.strip()
    message.set_content(body.strip())

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
            smtp.login(sender, password)
            smtp.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        raise RuntimeError(
            "Gmail rejected authentication. Verify GMAIL_ADDRESS and use a Google App Password, not your regular Gmail password."
        ) from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise RuntimeError(
            f"Could not send email through Gmail SMTP: {type(exc).__name__}: {exc}"
        ) from exc

    return {
        "success": True,
        "message": "Email sent successfully.",
        "to": recipient,
        "subject": subject.strip(),
    }
