import os
from dotenv import load_dotenv
from firebase_service import initialize_firebase

load_dotenv()

try:
    initialize_firebase()
    print("SUCCESS: Firebase Admin initialized")
except Exception as error:
    print("FAILED:", error)