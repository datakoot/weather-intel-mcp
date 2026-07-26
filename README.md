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

## Data & attribution

Weather data comes from the [National Weather Service / NOAA](https://www.weather.gov) API; earthquakes and elevation from the [USGS](https://www.usgs.gov); address geocoding from the [US Census Bureau](https://geocoding.geo.census.gov) geocoder. All are US-government public domain.

Part of [Datakoot](https://datakoot.com) — keyless intelligence APIs for AI agents.
