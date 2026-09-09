# Irrigation Control Card

A custom Home Assistant Lovelace card that combines manual irrigation
controls (schedule on/off, manual run, duration) with a live weekly
schedule read directly from each automation's trigger configuration —
including a warning banner when two zones are scheduled to run at
overlapping times.

## Installation (HACS)

1. Add this repository to HACS as a custom repository (category: Dashboard).
2. Install "Irrigation Control Card" from HACS.
3. Add a card to your dashboard:

```yaml
type: custom:irrigation-control-card
title: Irrigation Controls
refresh_seconds: 60
zones:
  - name: Example Zone
    automation: automation.example
    manual_switch: switch.example
    duration: input_number.example
    edit_id: "1234567890123"
```

`edit_id` is the automation's internal ID (visible in the URL when editing
it, or at the top of its "Edit in YAML" view) — not its entity ID.
