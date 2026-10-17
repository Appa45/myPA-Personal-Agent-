"""Approximate IP-based location lookup; no Google Maps key required."""
import json
import urllib.request
import urllib.error


def get_location():
    """Return approximate location based on the server's public IP address."""
    request = urllib.request.Request(
        "https://ipapi.co/json/",
        headers={"User-Agent": "AURA-Voice-Assistant/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        if data.get("error"):
            return {"success": False, "error": "The IP location provider could not determine location."}
        return {
            "success": True,
            "city": data.get("city"),
            "region": data.get("region"),
            "country": data.get("country_name"),
            "latitude": data.get("latitude"),
            "longitude": data.get("longitude"),
            "accuracy": "Approximate IP-based location",
        }
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return {"success": False, "error": f"Location lookup failed: {exc}"}
