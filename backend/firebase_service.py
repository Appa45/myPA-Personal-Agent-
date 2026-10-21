
import os

import firebase_admin
from firebase_admin import credentials, messaging


def initialize_firebase():
    if firebase_admin._apps:
        return

    credential_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")

    if not credential_path:
        raise RuntimeError(
            "FIREBASE_SERVICE_ACCOUNT_PATH is missing from backend/.env"
        )

    if not os.path.isfile(credential_path):
        raise RuntimeError(
            f"Firebase service account file not found: {credential_path}"
        )

    credential = credentials.Certificate(credential_path)
    firebase_admin.initialize_app(credential)


def send_push_notification(
    token: str,
    title: str,
    body: str,
    url: str = "/",
):
    initialize_firebase()

    message = messaging.Message(
        token=token,
        notification=messaging.Notification(
            title=title,
            body=body,
        ),
        data={
            "title": title,
            "body": body,
            "url": url,
        },
    )

    return messaging.send(message)
