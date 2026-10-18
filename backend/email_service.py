
import os
import smtplib
from email.message import EmailMessage
from email.utils import parseaddr


def send_email(to_email: str, subject: str, body: str) -> dict:
    """Send a plain-text email using Gmail SMTP."""

    sender = os.getenv("GMAIL_ADDRESS", "").strip()
    password = os.getenv("GMAIL_APP_PASSWORD", "").replace(" ", "")

    if not sender or not password:
        raise RuntimeError(
            "GMAIL_ADDRESS or GMAIL_APP_PASSWORD is not configured."
        )

    # Basic validation before sending.
    parsed_sender = parseaddr(sender)[1]
    parsed_recipient = parseaddr(to_email)[1]

    if parsed_recipient != to_email.strip() or "@" not in parsed_recipient:
        raise ValueError("Please provide a valid recipient email address.")

    if parsed_sender != sender or "@" not in parsed_sender:
        raise RuntimeError("GMAIL_ADDRESS is not a valid email address.")

    if not subject.strip():
        raise ValueError("Email subject cannot be empty.")

    if not body.strip():
        raise ValueError("Email message cannot be empty.")

    message = EmailMessage()
    message["From"] = sender
    message["To"] = parsed_recipient
    message["Subject"] = subject.strip()
    message.set_content(body.strip())

    # Gmail SMTP over implicit TLS.
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(sender, password)
        smtp.send_message(message)

    return {
        "success": True,
        "message": "Email sent successfully.",
        "to": parsed_recipient,
        "subject": subject.strip(),
    }
