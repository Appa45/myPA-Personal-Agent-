"""Natural-language reminder parsing for AURA (no network, no scheduling)."""
import re
from datetime import datetime, timedelta
from typing import Optional

DEFAULT_REMINDER_BODY = "Your scheduled reminder is due."


_WORD_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "fifteen": 15,
    "twenty": 20, "thirty": 30, "forty": 40, "sixty": 60,
}
_NUMBER_WORDS_RE = "|".join(sorted(_WORD_NUMBERS, key=len, reverse=True))

_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}
_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12, "jan": 1, "feb": 2, "aug": 8, "sept": 9, "sep": 9,
    "oct": 10, "nov": 11, "dec": 12,
}
_PART_OF_DAY_HOURS = {"morning": 9, "afternoon": 15, "evening": 18, "night": 21}

_MONTHS_RE = "|".join(sorted(_MONTHS, key=len, reverse=True))
_WEEKDAYS_RE = "|".join(_WEEKDAYS)

_HALF_HOUR_RE = re.compile(r"\b(?:in|after)\s+half\s+(?:an\s+)?hour\b", re.I)
_RELATIVE_RE = re.compile(
    rf"\b(?:in|after)\s+(?:about\s+)?(?P<n>\d+|{_NUMBER_WORDS_RE})\s*"
    r"(?P<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b",
    re.I,
)
_ISO_DATE_RE = re.compile(r"\b(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})\b")
_DAY_MONTH_RE = re.compile(
    rf"\b(?:on\s+)?(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<mon>{_MONTHS_RE})\b",
    re.I,
)
_MONTH_DAY_RE = re.compile(
    rf"\b(?:on\s+)?(?P<mon>{_MONTHS_RE})\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\b",
    re.I,
)
_DAY_WORD_RE = re.compile(r"\b(?P<w>day after tomorrow|tomorrow|today|tonight)\b", re.I)
_WEEKDAY_RE = re.compile(
    rf"\b(?:(?P<prefix>on|this|next|coming)\s+)?(?P<wd>{_WEEKDAYS_RE})\b", re.I
)
_PART_OF_DAY_RE = re.compile(
    r"\b(?:(?:in the|this)\s+"
    + "".join(f"|(?<={w}\\s)" for w in ["tomorrow", "today", *_WEEKDAYS])
    + r")(?P<p>morning|afternoon|evening|night)\b",
    re.I,
)
_NOON_RE = re.compile(r"\b(?:at\s+)?(?P<w>noon|midnight)\b", re.I)
_TIME_MERIDIEM_RE = re.compile(
    r"\b(?:at\s+)?(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>a\.?m\.?|p\.?m\.?)(?!\w)",
    re.I,
)
_TIME_COLON_RE = re.compile(r"\b(?:at\s+)?(?P<h>\d{1,2}):(?P<m>\d{2})(?!\w)", re.I)
_TIME_AT_RE = re.compile(r"\bat\s+(?P<h>\d{1,2})(?!\w|:)", re.I)

_TITLE_PREFIX_RE = re.compile(
    r"^\s*(?:(?:hey|hi|ok|okay)\s+aura[,.]?\s*)?(?:please\s+)?"
    r"(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?"
    r"(?:i(?:'d|\s+would|\s+want|\s+need)?\s+(?:like\s+|want\s+|need\s+)?to\s+)?"
    # "remainder" is a common speech-recognition mistake for "reminder".
    r"(?:(?:set|create|add|make|schedule)\s+(?:me\s+)?(?:a|an|my)?\s*(?:reminder|remainder)"
    r"|(?:remind|remember)\s+me)\s*(?:to|that|about|for)?\s*",
    re.I,
)
_TITLE_LEADING_FILLER_RE = re.compile(r"^(?:(?:at|on|in|by|for|to|and|then)\s+)+", re.I)
_TITLE_TRAILING_FILLER_RE = re.compile(r"(?:\s+(?:at|on|in|by|for|and|then))+$", re.I)


def _cut(pattern: re.Pattern, text: str):
    """Find `pattern` in `text`; return (match, text_with_match_removed)."""
    match = pattern.search(text)
    if not match:
        return None, text
    return match, f"{text[:match.start()]} {text[match.end():]}"


def _clean_title(text: str) -> str:
    text = " ".join(text.split())
    text = _TITLE_PREFIX_RE.sub("", text)
    text = text.strip(" ,.;:!?-")
    text = _TITLE_LEADING_FILLER_RE.sub("", text)
    text = _TITLE_TRAILING_FILLER_RE.sub("", text)
    text = " ".join(text.strip(" ,.;:!?-").split())
    return text[:1].upper() + text[1:] if text else ""


# "set a timer for 2 minutes" / "set a 2 minute timer" -> treated as "remind me in 2 minutes".
_TIMER_FOR_RE = re.compile(
    r"\b(?:set|start|create|make)\s+(?:me\s+)?(?:a|an|my)?\s*(?:timer|alarm)\s+(?:for|in|after)\b", re.I
)
_TIMER_NUM_RE = re.compile(
    rf"\b(?:set|start|create|make)\s+(?:me\s+)?(?:a|an|my)?\s*(?P<n>\d+|{_NUMBER_WORDS_RE})[\s-]*"
    r"(?P<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?)\s*(?:timer|alarm)\b",
    re.I,
)
_TIMER_WORD_RE = re.compile(r"\b(?:timer|alarm)\b", re.I)


def _normalize_timer(text: str):
    """Rewrite timer phrasing as a reminder command. Returns (text, is_timer)."""
    if not _TIMER_WORD_RE.search(text):
        return text, False
    rewritten = _TIMER_NUM_RE.sub(lambda m: f"remind me in {m['n']} {m['unit']}", text, count=1)
    if rewritten == text:
        rewritten = _TIMER_FOR_RE.sub("remind me in", text, count=1)
    return rewritten, True


def parse_reminder_command(text: str, now: datetime) -> dict:
    """
    Parse a natural-language reminder command such as:
      "remind me to call mom tomorrow at 9am"
      "remind me in 20 minutes to take the pizza out"
      "set a reminder for the meeting on Friday at 3:30 pm"
    Returns a dict describing the result. Nothing is scheduled here.
    """
    original = " ".join(text.split())
    remaining, is_timer = _normalize_timer(original)
    warnings: list[str] = []
    result = {
        "success": False,
        "original": original,
        "title": None,
        "body": DEFAULT_REMINDER_BODY,
        "due_at": None,
        "due_at_human": None,
        "timezone": str(now.tzinfo),
        "warnings": warnings,
        "missing": [],
        "error": None,
        "reminder": None,
    }

    def fail(message: str, missing: list[str]):
        result["error"] = message
        result["missing"] = missing
        return result

    due_at: Optional[datetime] = None

    # ---- 1. Relative offsets: "in 10 minutes", "in half an hour" ----
    match, rest = _cut(_HALF_HOUR_RE, remaining)
    if match:
        due_at = now + timedelta(minutes=30)
        remaining = rest
    else:
        match, rest = _cut(_RELATIVE_RE, remaining)
        if match:
            raw_n = match["n"].lower()
            amount = int(raw_n) if raw_n.isdigit() else _WORD_NUMBERS[raw_n]
            unit = match["unit"].lower()[0]
            delta = {
                "s": timedelta(seconds=amount),
                "m": timedelta(minutes=amount),
                "h": timedelta(hours=amount),
                "d": timedelta(days=amount),
                "w": timedelta(weeks=amount),
            }[unit]
            due_at = now + delta
            remaining = rest

    # ---- 2. Absolute date and time ----
    if due_at is None:
        today = now.date()
        day = None            # explicit calendar date (date object)
        day_offset = None     # today / tomorrow / day after tomorrow
        weekday = None
        weekday_prefix = ""
        is_tonight = False

        # Explicit dates
        match, rest = _cut(_ISO_DATE_RE, remaining)
        if match:
            try:
                day = datetime(int(match["y"]), int(match["m"]), int(match["d"])).date()
            except ValueError:
                return fail("That date doesn't exist.", ["when"])
            remaining = rest
        else:
            match, rest = _cut(_DAY_MONTH_RE, remaining)
            if not match:
                match, rest = _cut(_MONTH_DAY_RE, remaining)
            if match:
                month = _MONTHS[match["mon"].lower()]
                try:
                    day = datetime(now.year, month, int(match["d"])).date()
                    if day < today:
                        day = datetime(now.year + 1, month, int(match["d"])).date()
                except ValueError:
                    return fail("That date doesn't exist.", ["when"])
                remaining = rest

        # Part of day ("in the evening", "tomorrow morning") - before day words
        part = None
        match, rest = _cut(_PART_OF_DAY_RE, remaining)
        if match:
            part = match["p"].lower()
            remaining = rest

        # Relative day words / weekdays
        if day is None:
            match, rest = _cut(_DAY_WORD_RE, remaining)
            if match:
                word = match["w"].lower()
                is_tonight = word == "tonight"
                day_offset = {"today": 0, "tonight": 0, "tomorrow": 1, "day after tomorrow": 2}[word]
                remaining = rest
            else:
                match, rest = _cut(_WEEKDAY_RE, remaining)
                if match:
                    weekday = _WEEKDAYS[match["wd"].lower()]
                    weekday_prefix = (match["prefix"] or "").lower()
                    remaining = rest

        # Time of day
        hours: list[int] = []
        minute = 0
        ambiguous = False
        time_found = False

        match, rest = _cut(_TIME_MERIDIEM_RE, remaining)
        if match:
            hour = int(match["h"])
            minute = int(match["m"] or 0)
            if not (1 <= hour <= 12) or minute > 59:
                return fail("That time doesn't look valid.", ["when"])
            is_pm = match["ap"].lower().startswith("p")
            hours = [(hour % 12) + (12 if is_pm else 0)]
            time_found = True
            remaining = rest

        if not time_found:
            match, rest = _cut(_NOON_RE, remaining)
            if match:
                hours = [12 if match["w"].lower() == "noon" else 0]
                time_found = True
                remaining = rest

        if not time_found:
            match, rest = _cut(_TIME_COLON_RE, remaining)
            if not match:
                match, rest = _cut(_TIME_AT_RE, remaining)
            if match:
                hour = int(match["h"])
                minute = int(match.groupdict().get("m") or 0)
                if hour > 23 or minute > 59:
                    return fail("That time doesn't look valid.", ["when"])
                if 1 <= hour <= 12:
                    ambiguous = True
                    hours = [hour % 12, (hour % 12) + 12]
                else:
                    hours = [hour]
                time_found = True
                remaining = rest

        if not time_found and part:
            hours = [_PART_OF_DAY_HOURS[part]]
            time_found = True
        elif not time_found and is_tonight:
            hours = [_PART_OF_DAY_HOURS["night"]]
            time_found = True

        has_date = day is not None or day_offset is not None or weekday is not None

        if not time_found and not has_date:
            return fail(
                "I couldn't find when to remind you. Try 'tomorrow at 9am' or 'in 20 minutes'.",
                ["when"],
            )

        if not time_found:
            hours = [9]
            minute = 0
            warnings.append("No time was given, so 9:00 AM was assumed.")

        tz = now.tzinfo

        def at(d, h):
            return datetime(d.year, d.month, d.day, h, minute, tzinfo=tz)

        # Resolve the date
        if day is not None:
            if ambiguous:
                h = hours[0] if 7 <= hours[0] <= 11 else hours[1]
                hours = [h]
                warnings.append("AM/PM wasn't specified, so a likely time was assumed.")
            due_at = at(day, hours[0])
        elif day_offset is not None:
            target = today + timedelta(days=day_offset)
            if ambiguous:
                h = hours[0] if 7 <= hours[0] <= 11 else hours[1]
                hours = [h]
                warnings.append("AM/PM wasn't specified, so a likely time was assumed.")
            due_at = at(target, hours[0])
        elif weekday is not None:
            if ambiguous:
                h = hours[0] if 7 <= hours[0] <= 11 else hours[1]
                hours = [h]
                warnings.append("AM/PM wasn't specified, so a likely time was assumed.")
            days_ahead = (weekday - today.weekday()) % 7
            if weekday_prefix == "next" and days_ahead == 0:
                days_ahead = 7
            due_at = at(today + timedelta(days=days_ahead), hours[0])
            if due_at <= now:
                due_at = at(today + timedelta(days=days_ahead + 7), hours[0])
        else:
            # Time only: pick the next upcoming occurrence.
            due_at = None
            for h in hours:
                candidate = at(today, h)
                if candidate > now:
                    due_at = candidate
                    break
            if due_at is None:
                due_at = at(today + timedelta(days=1), hours[0])
                warnings.append("That time has passed today, so tomorrow was used.")

    if due_at <= now:
        return fail("That time is already in the past.", ["when"])

    title = _clean_title(remaining) or ("Timer" if is_timer else "")
    result["title"] = title or None
    result["due_at"] = due_at.isoformat()
    result["due_at_human"] = due_at.strftime("%A, %d %B %Y at %I:%M %p")

    if not title:
        return fail("I found the time but not what to remind you about.", ["title"])

    result["success"] = True
    result["reminder"] = {
        "title": title,
        "body": DEFAULT_REMINDER_BODY,
        "due_at": result["due_at"],
    }
    return result