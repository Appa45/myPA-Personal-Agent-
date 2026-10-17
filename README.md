# AURA — React + Python AI Voice Assistant

A React/Vite web interface connected to a Python FastAPI backend. It keeps the Groq chat, RSS news, and read-only Gmail tools from the supplied AURA backend and adds two location options:

- **Device location:** uses the browser's Geolocation API after you grant permission. Works on `localhost` for development and on HTTPS deployments.
- **Approximate IP location:** asks the Python backend to query `ipapi.co`. It does not require Google Maps API billing, but can be inaccurate and may locate the backend/network rather than the person using the browser.

The UI uses browser speech recognition (Chrome/Edge support varies by platform) and browser text-to-speech. This means voice input/output is handled by the browser, while Groq chat and tool calls run on the Python backend.

## Requirements

- Python 3.10+
- Node.js 18+
- A Groq API key
- Optional: Gmail address and Google App Password for read-only Gmail summaries

## 1. Configure backend

Open a terminal in the project root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend/.env` and set `GROQ_API_KEY`. Do not share or commit this file. For Gmail, set `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD` using a Google App Password; never use your normal Gmail password.

Start the backend (from the `backend` folder with the venv activated):

```powershell
uvicorn api:app --reload --host 127.0.0.1 --port 8000
```

Check `http://localhost:8000/api/health` and API docs at `http://localhost:8000/docs`.

## 2. Start React frontend

Open a second terminal in the project root:

```powershell
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). Keep the backend terminal running.

## Example prompts

- `Where am I right now?` — uses the AI's approximate IP-location tool.
- Use **Device location** for browser-granted coordinates and a Google Maps link.
- `Give me the latest technology news.`
- `Read my latest 3 unread emails and summarize them.`

## Notes and troubleshooting

- If the UI says the backend is not connected, start the backend and check the port.
- If the chat says `GROQ_API_KEY is missing`, make sure the file is named `backend/.env`, then restart Uvicorn.
- Device location is permission-based. If denied, change site permissions in the browser. Browser geolocation requires HTTPS except for localhost.
- Browser speech recognition support depends on browser and operating system. If the microphone button is unsupported, type into the message field.
- The backend's `get_location` is IP-based and approximate; device geolocation is usually more precise but accuracy depends on hardware and available signals.
- Gmail access is read-only in the supplied tool; it does not send, delete, or modify email.
- Keep `.env` private. Do not expose `GROQ_API_KEY` or Gmail app passwords in React/Vite environment variables.

## Included original desktop files

`backend/assistant.py` is the Python assistant backend used by the API. `backend/voice_assistant_gui.py` is included as the original desktop GUI reference; the React app does not need to run it.
