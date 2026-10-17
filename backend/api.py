import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR))

import assistant as core  # noqa: E402
from location_service import get_location  # noqa: E402

app = FastAPI(title="AURA Assistant API", version="1.0.0")
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


@app.get("/health")
def health():
    return {"ok": True, "configured": bool(os.getenv("GROQ_API_KEY"))}

@app.post("/chat")
def chat(payload: ChatRequest):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(status_code=503, detail="GROQ_API_KEY is missing. Add it to backend/.env and restart the server.")
    try:
        return {"reply": core.think(payload.message.strip())}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Assistant request failed: {type(exc).__name__}: {exc}") from exc

@app.get("/location")
def location():
    result = get_location()
    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("error", "Location lookup failed"))
    return result
