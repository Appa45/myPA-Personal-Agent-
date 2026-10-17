"""

Blue Orb Voice Assistant - desktop GUI for the existing assistant.py

Keep this file in the same folder as assistant.py.

Install:

    python -m pip install customtkinter

    python -m pip install sounddevice soundfile numpy groq feedparser python-dotenv pyttsx3

Run:

    python voice_assistant_gui.py

This GUI uses assistant.py for microphone recording, Groq transcription,

LLM responses, news/email tools, and speech output.

"""

import threading

import time

import tkinter as tk

try:

    import customtkinter as ctk

except ImportError:

    raise SystemExit(

        "customtkinter is missing. Install it with: python -m pip install customtkinter"

    )

# Import the backend module. This GUI must NOT be saved as assistant.py,

# because that filename belongs to the backend and would shadow this import.

try:

    import assistant as core

except Exception as exc:

    raise SystemExit(

        "Could not import assistant.py. Keep this GUI file named "

        "'voice_assistant_gui.py' and keep your backend named 'assistant.py' "

        "in the same folder. Original error: " + str(exc)

    )

if not hasattr(core, "reset_history") or not hasattr(core, "record"):

    raise SystemExit(

        "Wrong assistant.py was imported. Restore the backend assistant.py "

        "that contains reset_history(), record(), speech_to_text(), think(), and speak(). "

        "Save this GUI as voice_assistant_gui.py, not assistant.py."

    )

# ------------------------------ Appearance ----------------------------------

ctk.set_appearance_mode("dark")

ctk.set_default_color_theme("blue")

BG = "#07111F"

PANEL = "#0D1B2E"

BLUE = "#258BFF"

BLUE_LIGHT = "#65C2FF"

TEXT = "#F2F7FF"

MUTED = "#91A8C4"

GREEN = "#5CE1B6"

RED = "#FF6B81"

class VoiceAssistantGUI(ctk.CTk):

    def __init__(self):

        super().__init__()

        self.title("Blue Voice Assistant")

        self.geometry("760x780")

        self.minsize(620, 660)

        self.configure(fg_color=BG)

        self.busy = False

        self.listening = False

        self.orb_phase = 0

        self.current_state = "READY"

        self.last_user_text = ""

        self.last_reply = ""

        core.reset_history()

        self._build_ui()

        self._animate_orb()

        self._set_state("READY", "Your assistant is ready")

        self.after(500, self._speak_greeting)

    def _build_ui(self):
        # Main page with a clean, modern dashboard layout.
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(3, weight=1)

        header = ctk.CTkFrame(self, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=30, pady=(24, 0))
        header.grid_columnconfigure(0, weight=1)

        brand_wrap = ctk.CTkFrame(header, fg_color="transparent")
        brand_wrap.grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(
            brand_wrap, text="✦", text_color=BLUE_LIGHT,
            font=ctk.CTkFont(size=25, weight="bold")
        ).pack(side="left", padx=(0, 9))
        ctk.CTkLabel(
            brand_wrap, text="AURA", text_color=TEXT,
            font=ctk.CTkFont(family="Segoe UI", size=18, weight="bold")
        ).pack(side="left")
        ctk.CTkLabel(
            brand_wrap, text="  VOICE ASSISTANT", text_color=MUTED,
            font=ctk.CTkFont(size=10, weight="bold")
        ).pack(side="left", pady=(4, 0))

        self.status_badge = ctk.CTkLabel(
            header, text="● READY", text_color=GREEN,
            fg_color="#102B2C", corner_radius=20,
            font=ctk.CTkFont(size=11, weight="bold"),
            padx=14, pady=7
        )
        self.status_badge.grid(row=0, column=1, sticky="e")

        hero = ctk.CTkFrame(self, fg_color="transparent")
        hero.grid(row=1, column=0, sticky="ew", padx=20, pady=(22, 0))
        ctk.CTkLabel(
            hero, text="Your personal AI,\njust a conversation away.",
            text_color=TEXT, justify="center",
            font=ctk.CTkFont(family="Segoe UI", size=27, weight="bold")
        ).pack(pady=(0, 7))
        ctk.CTkLabel(
            hero, text="Speak naturally. I’m listening whenever you’re ready.",
            text_color=MUTED, font=ctk.CTkFont(size=13)
        ).pack()

        orb_area = ctk.CTkFrame(self, fg_color="transparent")
        orb_area.grid(row=2, column=0, sticky="ew", padx=20, pady=(0, 0))
        self.orb_canvas = tk.Canvas(
            orb_area, width=360, height=290, bg=BG,
            highlightthickness=0, bd=0
        )
        self.orb_canvas.pack(pady=(0, 0))
        self._draw_orb()

        self.state_label = ctk.CTkLabel(
            orb_area, text="READY TO CONNECT", text_color=BLUE_LIGHT,
            font=ctk.CTkFont(size=12, weight="bold")
        )
        self.state_label.pack(pady=(0, 4))
        self.hint_label = ctk.CTkLabel(
            orb_area, text="Starting hands-free listening after the greeting...",
            text_color=MUTED, font=ctk.CTkFont(size=11)
        )
        self.hint_label.pack(pady=(0, 12))

        conversation = ctk.CTkFrame(
            self, fg_color=PANEL, corner_radius=20,
            border_width=1, border_color="#1A3555"
        )
        conversation.grid(row=3, column=0, sticky="nsew", padx=28, pady=(0, 14))
        conversation.grid_columnconfigure(0, weight=1)
        conversation.grid_rowconfigure(1, weight=1)

        conversation_header = ctk.CTkFrame(conversation, fg_color="transparent")
        conversation_header.grid(row=0, column=0, sticky="ew", padx=18, pady=(14, 7))
        ctk.CTkLabel(
            conversation_header, text="CONVERSATION", text_color=TEXT,
            font=ctk.CTkFont(size=11, weight="bold")
        ).pack(side="left")
        ctk.CTkLabel(
            conversation_header, text="LIVE TRANSCRIPT", text_color=BLUE_LIGHT,
            font=ctk.CTkFont(size=9, weight="bold")
        ).pack(side="right")

        self.transcript = ctk.CTkTextbox(
            conversation, height=115, wrap="word",
            fg_color="#091625", text_color=TEXT,
            border_width=1, border_color="#162C45", corner_radius=12,
            font=ctk.CTkFont(family="Segoe UI", size=13),
            scrollbar_button_color="#29496B",
            scrollbar_button_hover_color=BLUE
        )
        self.transcript.grid(row=1, column=0, sticky="nsew", padx=12, pady=(0, 12))
        self.transcript.insert("end", "Assistant: Hi! How can I help you?\n\n")
        self.transcript.configure(state="disabled")

        controls = ctk.CTkFrame(self, fg_color="transparent")
        controls.grid(row=4, column=0, sticky="ew", padx=28, pady=(0, 22))
        controls.grid_columnconfigure(0, weight=1)
        self.mic_button = ctk.CTkButton(
            controls, text="🎙   Start hands-free conversation",
            command=self.start_listening, height=50, corner_radius=15,
            fg_color=BLUE, hover_color="#1472D4",
            border_width=1, border_color="#5AB0FF",
            font=ctk.CTkFont(size=14, weight="bold")
        )
        self.mic_button.grid(row=0, column=0, sticky="ew", padx=(0, 9))
        self.stop_button = ctk.CTkButton(
            controls, text="■  Stop", command=self.stop_request,
            height=50, width=100, corner_radius=15,
            fg_color="#1A2B40", hover_color="#2A405B",
            border_width=1, border_color="#304762",
            text_color=TEXT, state="disabled",
            font=ctk.CTkFont(size=13, weight="bold")
        )
        self.stop_button.grid(row=0, column=1, sticky="e")

        footer = ctk.CTkLabel(
            self, text="POWERED BY GROQ  •  ESC TO STOP", text_color="#607995",
            font=ctk.CTkFont(size=9, weight="bold")
        )
        footer.grid(row=5, column=0, pady=(0, 12))

        self.bind("<Escape>", lambda _event: self.stop_request())
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _draw_orb(self):
        self.orb_canvas.delete("all")
        cx, cy = 180, 139
        active = self.current_state in ("LISTENING", "THINKING", "SPEAKING")
        pulse = (self.orb_phase % 30) / 30
        expansion = int(10 * pulse) if active else 0

        # Subtle ambient rings create a glowing, animated-orb effect.
        for radius, color, width in [
            (125 + expansion, "#10233B", 2),
            (108 + expansion, "#12345A", 2),
            (92 + expansion, "#174575", 2),
        ]:
            self.orb_canvas.create_oval(
                cx-radius, cy-radius, cx+radius, cy+radius,
                fill=BG, outline=color, width=width
            )

        orb_radius = 76 + (3 if active else 0)
        layers = [
            (orb_radius, "#0C4DA2"),
            (orb_radius-9, "#1264C0"),
            (orb_radius-20, "#187BE7"),
            (orb_radius-33, "#2699FF"),
            (orb_radius-46, "#76D2FF"),
            (orb_radius-56, "#C5F0FF"),
        ]
        for radius, color in layers:
            self.orb_canvas.create_oval(
                cx-radius, cy-radius, cx+radius, cy+radius,
                fill=color, outline=color
            )

        self.orb_canvas.create_oval(
            cx-34, cy-49, cx+8, cy-20,
            fill="#E4FAFF", outline="#E4FAFF"
        )
        icon = "✦"
        if self.current_state == "LISTENING":
            icon = "●"
        elif self.current_state == "THINKING":
            icon = "···"
        elif self.current_state == "SPEAKING":
            icon = "♫"
        self.orb_canvas.create_text(
            cx, cy+10, text=icon, fill="#07305A",
            font=("Segoe UI Symbol", 27, "bold")
        )

    def _animate_orb(self):

        self.orb_phase += 1

        self._draw_orb()

        self.after(100, self._animate_orb)

    def _set_state(self, state, hint):

        self.current_state = state

        self.state_label.configure(text={"READY": "READY TO CONNECT", "LISTENING": "LISTENING TO YOU", "TRANSCRIBING": "UNDERSTANDING YOUR VOICE", "THINKING": "THINKING IT THROUGH", "SPEAKING": "REPLYING TO YOU", "ERROR": "NEEDS ATTENTION"}.get(state, state))

        self.hint_label.configure(text=hint)

        color = {

            "READY": GREEN,

            "LISTENING": BLUE_LIGHT,

            "TRANSCRIBING": BLUE_LIGHT,

            "THINKING": "#C6A6FF",

            "SPEAKING": GREEN,

            "ERROR": RED,

        }.get(state, BLUE_LIGHT)

        self.status_badge.configure(text=f"● {state}", text_color=color)

        if state == "LISTENING":

            self.mic_button.configure(text="🎙  Listening...", state="disabled")

        elif self.busy:

            self.mic_button.configure(text="Please wait...", state="disabled")

        else:

            self.mic_button.configure(text="🎙  Start hands-free conversation", state="normal")

    def _append_conversation(self, speaker, text):

        self.transcript.configure(state="normal")

        self.transcript.insert("end", f"{speaker}: {text}\n\n")

        self.transcript.see("end")

        self.transcript.configure(state="disabled")

    def _speak_greeting(self):

        threading.Thread(

            target=self._speak_greeting_worker, daemon=True

        ).start()

    def _speak_greeting_worker(self):

        try:

            core.speak("Hi! How can I help you?")

            # Begin hands-free listening after the greeting finishes.

            self.after(250, self.start_listening)

        except Exception as exc:

            # Exception variables are cleared when the except block ends.

            # Capture the message now before scheduling the Tkinter callback.

            error_message = f"{type(exc).__name__}: {exc}"

            try:

                self.after(

                    0,

                    lambda message=error_message: self._set_state(

                        "READY", f"Voice output unavailable: {message}"

                    ),

                )

            except tk.TclError:

                # The window may have been closed while speech was starting.

                pass

    def start_listening(self):

        """Start a hands-free conversation loop; no repeated button presses needed."""

        if self.busy:

            return

        self.busy = True

        self.listening = True

        self.stop_button.configure(state="normal")

        self._set_state("LISTENING", "Hands-free mode: speak now, then pause briefly")

        self.mic_button.configure(text="🎙  Hands-free listening...", state="disabled")

        threading.Thread(target=self._listen_worker, daemon=True).start()

    def _listen_worker(self):

        """Repeat microphone -> transcription -> AI -> speech until Stop is pressed."""

        import time

        try:

            while self.listening:

                print("\n[VOICE DEBUG] STEP 1: Listening for your next sentence...", flush=True)

                audio = core.record()

                print(

                    "[VOICE DEBUG] STEP 2: Recording finished; audio is None:",

                    audio is None,

                    "type:", type(audio).__name__,

                    flush=True,

                )

                if not self.listening:

                    break

                if audio is None:

                    print("[VOICE DEBUG] No audio captured; listening again.", flush=True)

                    time.sleep(0.25)

                    continue

                self.after(0, lambda: self._set_state("TRANSCRIBING", "Converting your voice to text..."))

                print("[VOICE DEBUG] STEP 3: Transcribing audio...", flush=True)

                user_text = core.speech_to_text(audio)

                print("[VOICE DEBUG] STEP 4: Recognized speech:", repr(user_text), flush=True)

                if not user_text or not str(user_text).strip():

                    print("[VOICE DEBUG] No speech recognized; listening again.", flush=True)

                    continue

                user_text = str(user_text).strip()

                self.after(0, lambda text=user_text: self._append_conversation("You", text))

                if user_text.lower().strip(" .!?") in {"quit", "exit", "stop", "goodbye", "bye", "stop listening"}:

                    farewell = "Goodbye! I’ll stop listening now."

                    self.after(0, lambda text=farewell: self._append_conversation("Assistant", text))

                    try:

                        core.speak(farewell)

                    except Exception as speech_exc:

                        print("[VOICE DEBUG] Farewell speech failed:", speech_exc, flush=True)

                    self.listening = False

                    break

                self.after(0, lambda: self._set_state("THINKING", "Working on your request..."))
                print("[VOICE DEBUG] STEP 5: Sending text to AI:", repr(user_text), flush=True)
                reply = core.think(user_text)
                print("[VOICE DEBUG] STEP 6: AI response:", repr(reply), flush=True)
                if reply is None or not str(reply).strip():
                    raise RuntimeError("The AI returned an empty response. Check the model/API configuration.")

                reply = str(reply).strip()
                self.after(0, lambda text=reply: self._append_conversation("Assistant", text))

                self.after(0, lambda: self._set_state("SPEAKING", "Speaking; I’ll listen again when I finish..."))

                print("[VOICE DEBUG] STEP 7: Speaking response...", flush=True)

                core.speak(reply)

                print("[VOICE DEBUG] STEP 8: Speech finished; returning to listening mode.", flush=True)

                # Loop back to core.record() automatically after the spoken reply.

        except Exception as exc:

            message = f"{type(exc).__name__}: {exc}"

            print("[VOICE DEBUG] ERROR:", message, flush=True)

            import traceback

            traceback.print_exc()

            self.after(0, lambda msg=message: self._show_error(msg))

        finally:

            self.busy = False

            self.listening = False

            try:

                self.after(0, self._set_idle)

                self.after(0, lambda: self.stop_button.configure(state="disabled"))

                self.after(0, self._refresh_ready_button)

            except tk.TclError:

                pass

    def _ready_after_empty_recording(self):

        self._set_state("READY", "I didn't catch that. Hands-free mode will keep listening.")

    def _set_idle(self):

        self._set_state("READY", "Conversation paused. Start hands-free conversation to resume.")

    def _refresh_ready_button(self):

        if not self.busy:

            self.mic_button.configure(text="🎙  Start hands-free conversation", state="normal")

            self.stop_button.configure(state="disabled")

    def _show_error(self, message):

        self._set_state("ERROR", "Something went wrong. Check the details below.")

        self._append_conversation("Error", message)

        self.after(3000, self._set_idle)

    def stop_request(self):

        # The current recording ends after silence (or the configured max duration).

        # Then the conversation loop exits without starting another recording.

        if self.busy:

            self.listening = False

            self.hint_label.configure(text="Stopping after the current recording finishes...")

            self.stop_button.configure(state="disabled")

    def _on_close(self):

        self.destroy()

if __name__ == "__main__":

    app = VoiceAssistantGUI()

    app.mainloop()
