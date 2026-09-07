# Weather & Geo Intel MCP — by Datakoot

US weather, hazards and geospatial data for AI agents — as MCP tools your agent can call mid-task for forecasts, alerts, earthquakes and elevation. All from keyless US-government feeds. No API keys.

## Tools

| Tool | What it does | Source |
|---|---|---|
| `geocode` | Convert a US street address to latitude/longitude | US Census Bureau |
| `weather_forecast` | Multi-day or hourly forecast for a US point | NWS / NOAA |
| `weather_current` | Latest observed conditions from the nearest station | NWS / NOAA |
| `weather_alerts` | Active warnings, watches and advisories by US state | NWS / NOAA |
| `earthquakes` | Recent earthquakes, filterable by magnitude, time and area | USGS |
| `elevation` | Ground elevation at a latitude/longitude | USGS |

US coverage. Have an address? Call `geocode` first, then the weather tools. No API keys required.

## Quick start

```
claude mcp add --transport http weather-intel https://weather.datakoot.com/mcp
```

Or point any MCP client at `https://weather.datakoot.com/mcp`.

## Try it in 10 seconds — no key, no signup

Paste this into a terminal:

```bash
curl -s https://weather.datakoot.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "weather_forecast", "arguments": {"lat": 36.37, "lon": -94.21}}}'
```

You get the multi-day National Weather Service forecast for Bentonville, AR — no API key, nothing to sign up for.

Or point any MCP client at the URL and just ask your agent, in plain language:

- "What's the weather in Chicago this week?"
- "Are there any active weather alerts in Texas right now?"


## Data & attribution

Weather data comes from the [National Weather Service / NOAA](https://www.weather.gov) API; earthquakes and elevation from the [USGS](https://www.usgs.gov); address geocoding from the [US Census Bureau](https://geocoding.geo.census.gov) geocoder. All are US-government public domain.

Part of [Datakoot](https://datakoot.com) — keyless intelligence APIs for AI agents.
