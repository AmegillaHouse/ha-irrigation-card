/* Irrigation Control Card (merged)
 * One wide card combining manual controls (timer on/off, manual run, duration)
 * with a live weekly schedule read straight from each automation's trigger
 * config — the same endpoint the "Edit in YAML" view uses, so days/time
 * always reflect what's actually saved, no manual syncing.
 *
 * Install:
 *   1. Copy this file to /config/www/irrigation-control-card.js
 *      (put it directly in www/, not a subfolder, unless you also update
 *      the resource URL below to match)
 *   2. Settings -> Dashboards -> (top right ⋮) -> Resources -> Add Resource
 *        URL: /local/irrigation-control-card.js
 *        Type: JavaScript Module
 *   3. Add a card to your dashboard:
 *        type: custom:irrigation-control-card
 *        title: Irrigation Controls
 *        zones:
 *          - name: Figs
 *            automation: automation.ha_watering_figs
 *            manual_switch: switch.greenhouse_switch_2
 *            duration: input_number.watering_duration_figs
 *            edit_id: "1714278099316"
 *          ...
 *
 * Also cross-checks every zone's start time + duration against every other
 * zone for the same day and flags overlapping windows: the day-pill turns
 * orange (hover for which zone it clashes with), and a summary banner lists
 * every overlap in plain text above the table. This only catches overlaps
 * between zones managed by this card's config — it can't see watering
 * activity from anything outside that list.
 *
 * Requires an admin-logged-in session (same as the automation editor) to
 * read the live schedule; the manual controls work for any user with
 * control access to the underlying entities.
 */

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

class IrrigationControlCard extends HTMLElement {
  setConfig(config) {
    if (!config.zones || !Array.isArray(config.zones) || config.zones.length === 0) {
      throw new Error(
        'irrigation-control-card: "zones" is required — a list of {name, automation, manual_switch, duration, edit_id}'
      );
    }
    this._config = config;
    this._refreshSeconds = config.refresh_seconds || 60;
    this._schedules = {}; // cache of {weekday, at} keyed by edit_id

    if (!this._built) {
      this._built = true;
      this.innerHTML = `
        <ha-card>
          <div class="card-header">
            <div class="name">${this._escape(config.title || "Irrigation Controls")}</div>
            <ha-icon id="refresh-btn" icon="mdi:refresh" title="Refresh schedule"></ha-icon>
          </div>
          <div class="card-content" id="content">Loading…</div>
        </ha-card>
        <style>
          ha-card { padding: 0; }
          .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 16px 0 16px;
            font-size: 1.2em;
            font-weight: 500;
            color: var(--ha-card-header-color, var(--primary-text-color));
          }
          #refresh-btn {
            cursor: pointer;
            color: var(--secondary-text-color);
            --mdc-icon-size: 20px;
          }
          #refresh-btn:hover { color: var(--primary-color); }
          .card-content { padding: 8px 16px 16px 16px; overflow-x: auto; }
          table { border-collapse: collapse; white-space: nowrap; }
          th, td { padding: 6px 10px; text-align: center; font-size: 12px; vertical-align: middle; }
          thead th {
            font-weight: 600;
            font-size: 11px;
            color: var(--secondary-text-color);
            text-transform: uppercase;
            padding-bottom: 10px;
          }
          td.zone-name {
            text-align: left;
            font-weight: 600;
            font-size: 13px;
            color: var(--primary-text-color);
          }
          tr.zone-row { border-top: 1px solid var(--divider-color); }

          .pill-btn {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            width: 52px;
            padding: 6px 4px;
            border-radius: 10px;
            cursor: pointer;
            user-select: none;
            border: none;
            background: transparent;
          }
          .pill-btn ha-icon { --mdc-icon-size: 22px; }
          .pill-label { font-size: 9px; font-weight: 700; letter-spacing: 0.3px; }

          .timer-on { background: rgba(76, 175, 80, 0.12); }
          .timer-on ha-icon, .timer-on .pill-label { color: var(--success-color); }
          .timer-off { background: rgba(158, 158, 158, 0.12); }
          .timer-off ha-icon, .timer-off .pill-label { color: var(--error-color); }

          .manual-on { background: rgba(33, 150, 243, 0.15); }
          .manual-on ha-icon, .manual-on .pill-label { color: #2196f3; }
          .manual-off { background: rgba(128, 128, 128, 0.08); }
          .manual-off ha-icon { color: var(--primary-text-color); }
          .manual-off .pill-label { color: var(--secondary-text-color); }

          .last-run { font-size: 11px; color: var(--secondary-text-color); }

          .duration-wrap { display: inline-flex; align-items: center; gap: 6px; }
          .duration-value { font-size: 14px; font-weight: 600; min-width: 20px; display: inline-block; }
          .stepper-btn {
            cursor: pointer;
            --mdc-icon-size: 18px;
            color: var(--secondary-text-color);
            border-radius: 50%;
            padding: 2px;
          }
          .stepper-btn:hover { color: var(--primary-color); background: rgba(128,128,128,0.1); }

          .day-cell { width: 24px; }
          .day-pill {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            font-size: 10px;
            font-weight: 600;
          }
          .day-on { background: var(--success-color); color: white; }
          .day-off { background: rgba(128,128,128,0.15); color: var(--secondary-text-color); opacity: 0.5; }
          .day-conflict {
            background: #ff9800;
            color: white;
            cursor: help;
            box-shadow: 0 0 0 2px #ff9800, 0 0 6px rgba(255, 152, 0, 0.7);
          }
          .time-cell { font-size: 12px; font-weight: 600; color: var(--primary-color); }

          .edit-btn { cursor: pointer; --mdc-icon-size: 22px; color: var(--primary-color); }
          .edit-btn:hover { opacity: 0.7; }

          .sched-error { font-size: 10px; color: var(--error-color); font-style: italic; }

          .conflict-banner {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            background: rgba(255, 152, 0, 0.12);
            border: 1px solid rgba(255, 152, 0, 0.4);
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 12px;
          }
          .conflict-banner ha-icon { color: #ff9800; --mdc-icon-size: 20px; flex-shrink: 0; margin-top: 1px; }
          .conflict-banner .conflict-title { font-weight: 700; font-size: 12px; color: #ff9800; margin-bottom: 4px; }
          .conflict-banner ul { margin: 0; padding-left: 18px; font-size: 12px; color: var(--primary-text-color); }
          .conflict-banner li { margin-bottom: 2px; }
        </style>
      `;
      this._content = this.querySelector("#content");
      this.querySelector("#refresh-btn").addEventListener("click", () => this._fetchSchedules());
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._fetchSchedules(); // kicks off first render once schedules land
      this._interval = setInterval(() => this._fetchSchedules(), this._refreshSeconds * 1000);
    } else {
      this._render(); // cheap re-render on every state update using cached schedules
    }
  }

  disconnectedCallback() {
    if (this._interval) clearInterval(this._interval);
  }

  _escape(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  _navigate(path) {
    history.pushState(null, "", path);
    const event = new Event("location-changed", { bubbles: true, composed: true });
    event.detail = { replace: false };
    window.dispatchEvent(event);
  }

  async _fetchSchedules() {
    if (!this._hass || !this._config) return;
    await Promise.all(
      this._config.zones.map(async (zone) => {
        try {
          const cfg = await this._hass.callApi(
            "GET",
            `config/automation/config/${zone.edit_id}`
          );
          this._schedules[zone.edit_id] = { trigger: this._extractTimeTrigger(cfg), error: null };
        } catch (err) {
          this._schedules[zone.edit_id] = { trigger: null, error: "load failed" };
        }
      })
    );
    this._render();
  }

  _extractTimeTrigger(cfg) {
    const raw = cfg.triggers || cfg.trigger || [];
    const list = Array.isArray(raw) ? raw : [raw];
    const t = list.find((tr) => tr && (tr.trigger === "time" || tr.platform === "time"));
    if (!t) return null;

    let atDisplay = t.at;
    if (typeof t.at === "string" && t.at.includes(".") && this._hass.states[t.at]) {
      atDisplay = this._hass.states[t.at].state;
    }
    const weekday = t.weekday ? (Array.isArray(t.weekday) ? t.weekday : [t.weekday]) : DAY_KEYS;
    return { at: atDisplay, weekday };
  }

  _parseMinutes(timeStr) {
    if (!timeStr) return null;
    const parts = String(timeStr).split(":");
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }

  _fmtMinutes(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = Math.round(mins % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // For each zone, resolve {name, weekday[], startMin, durationMin} where possible.
  // Zones missing a live schedule, time, or duration are simply excluded from
  // conflict checking (not flagged as errors — they're likely still loading).
  _buildScheduleRows(zones) {
    return zones.map((zone) => {
      const sched = this._schedules[zone.edit_id];
      const durationState = this._hass.states[zone.duration];
      if (!sched || !sched.trigger || !durationState) return null;

      const startMin = this._parseMinutes(sched.trigger.at);
      const durationMin = parseFloat(durationState.state);
      if (startMin == null || Number.isNaN(durationMin)) return null;

      return {
        name: zone.name,
        weekday: sched.trigger.weekday,
        startMin,
        durationMin,
      };
    });
  }

  // Pairwise overlap check per day. Cheap enough at this scale (a handful of
  // zones × 7 days) that a simple O(n²) sweep per day is plenty fast, and it
  // makes it trivial to report exactly which zones clash with which.
  _computeConflicts(rows) {
    const conflictsByKey = {}; // "<zoneIndex>-<day>" -> Set of other zone names
    const messages = [];
    const seenPairs = new Set();

    DAY_KEYS.forEach((day) => {
      const active = [];
      rows.forEach((r, idx) => {
        if (r && r.weekday.includes(day)) {
          active.push({ idx, name: r.name, start: r.startMin, end: r.startMin + r.durationMin });
        }
      });
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i];
          const b = active[j];
          const overlaps = a.start < b.end && b.start < a.end;
          if (!overlaps) continue;

          (conflictsByKey[`${a.idx}-${day}`] = conflictsByKey[`${a.idx}-${day}`] || new Set()).add(b.name);
          (conflictsByKey[`${b.idx}-${day}`] = conflictsByKey[`${b.idx}-${day}`] || new Set()).add(a.name);

          const pairKey = `${day}-${Math.min(a.idx, b.idx)}-${Math.max(a.idx, b.idx)}`;
          if (!seenPairs.has(pairKey)) {
            seenPairs.add(pairKey);
            const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
            messages.push(
              `${dayLabel}: ${a.name} (${this._fmtMinutes(a.start)}–${this._fmtMinutes(a.end)}) overlaps ${b.name} (${this._fmtMinutes(b.start)}–${this._fmtMinutes(b.end)})`
            );
          }
        }
      }
    });

    return { conflictsByKey, messages };
  }

  _lastRunText(automationEntity) {
    const st = this._hass.states[automationEntity];
    const t = st && st.attributes && st.attributes.last_triggered;
    if (!t) return "Never run";
    const diff = Math.floor((Date.now() - new Date(t).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  _render() {
    if (!this._hass || !this._config) return;
    const zones = this._config.zones;

    const scheduleRows = this._buildScheduleRows(zones);
    const { conflictsByKey, messages } = this._computeConflicts(scheduleRows);

    let html = "";
    if (messages.length > 0) {
      html += `
        <div class="conflict-banner">
          <ha-icon icon="mdi:alert"></ha-icon>
          <div>
            <div class="conflict-title">${messages.length} schedule ${messages.length === 1 ? "conflict" : "conflicts"} detected</div>
            <ul>${messages.map((m) => `<li>${this._escape(m)}</li>`).join("")}</ul>
          </div>
        </div>`;
    }

    html += `<table><thead><tr>
      <th style="text-align:left">Device</th>
      <th>Timer</th>
      <th>Last Run</th>
      <th>Manual</th>
      <th>Duration</th>`;
    DAY_LABELS.forEach((d) => (html += `<th>${d}</th>`));
    html += `<th>Time</th><th>Edit</th></tr></thead><tbody>`;

    zones.forEach((zone, zoneIdx) => {
      const autoState = this._hass.states[zone.automation];
      const manualState = this._hass.states[zone.manual_switch];
      const durationState = this._hass.states[zone.duration];
      const sched = this._schedules[zone.edit_id];

      const timerOn = autoState && autoState.state === "on";
      const manualOn = manualState && manualState.state === "on";
      const durationVal = durationState ? durationState.state : "—";

      html += `<tr class="zone-row">`;
      html += `<td class="zone-name">${this._escape(zone.name)}</td>`;

      // Timer
      html += `
        <td>
          <button class="pill-btn ${timerOn ? "timer-on" : "timer-off"}" data-action="toggle-timer" data-automation="${zone.automation}">
            <ha-icon icon="${timerOn ? "mdi:toggle-switch" : "mdi:toggle-switch-off-outline"}"></ha-icon>
            <span class="pill-label">${timerOn ? "ON" : "OFF"}</span>
          </button>
        </td>`;

      // Last Run
      html += `<td class="last-run">${this._escape(this._lastRunText(zone.automation))}</td>`;

      // Manual
      html += `
        <td>
          <button class="pill-btn ${manualOn ? "manual-on" : "manual-off"}" data-action="run-manual" data-automation="${zone.automation}">
            <ha-icon icon="${manualOn ? "mdi:water" : "mdi:water-outline"}"></ha-icon>
            <span class="pill-label">${manualOn ? "RUNNING" : "RUN"}</span>
          </button>
        </td>`;

      // Duration
      html += `
        <td>
          <div class="duration-wrap">
            <ha-icon class="stepper-btn" icon="mdi:minus" data-action="dec-duration" data-duration="${zone.duration}"></ha-icon>
            <span class="duration-value">${this._escape(durationVal)}</span>
            <ha-icon class="stepper-btn" icon="mdi:plus" data-action="inc-duration" data-duration="${zone.duration}"></ha-icon>
          </div>
        </td>`;

      // Days + Time
      if (!sched) {
        html += `<td colspan="${DAY_KEYS.length + 1}" class="sched-error">loading…</td>`;
      } else if (sched.error) {
        html += `<td colspan="${DAY_KEYS.length + 1}" class="sched-error">${this._escape(sched.error)}</td>`;
      } else if (!sched.trigger) {
        html += `<td colspan="${DAY_KEYS.length + 1}" class="sched-error">no time trigger</td>`;
      } else {
        DAY_KEYS.forEach((d) => {
          const active = sched.trigger.weekday.includes(d);
          const conflictSet = conflictsByKey[`${zoneIdx}-${d}`];
          const isConflict = active && conflictSet;
          const cls = isConflict ? "day-conflict" : active ? "day-on" : "day-off";
          const title = isConflict ? ` title="Overlaps with: ${this._escape(Array.from(conflictSet).join(", "))}"` : "";
          html += `<td class="day-cell"><span class="day-pill ${cls}"${title}></span></td>`;
        });
        const timeDisplay = sched.trigger.at ? String(sched.trigger.at).slice(0, 5) : "—";
        html += `<td class="time-cell">${this._escape(timeDisplay)}</td>`;
      }

      // Edit
      html += `
        <td>
          <ha-icon class="edit-btn" icon="mdi:pencil" data-action="edit" data-edit-id="${zone.edit_id}"></ha-icon>
        </td>`;

      html += `</tr>`;
    });

    html += `</tbody></table>`;
    this._content.innerHTML = html;
    this._attachHandlers();
  }

  _attachHandlers() {
    this._content.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const action = e.currentTarget.dataset.action;
        if (action === "toggle-timer") {
          this._hass.callService("automation", "toggle", {
            entity_id: e.currentTarget.dataset.automation,
          });
        } else if (action === "run-manual") {
          this._hass.callService("automation", "trigger", {
            entity_id: e.currentTarget.dataset.automation,
            skip_condition: true,
          });
        } else if (action === "inc-duration") {
          this._hass.callService("input_number", "increment", {
            entity_id: e.currentTarget.dataset.duration,
          });
        } else if (action === "dec-duration") {
          this._hass.callService("input_number", "decrement", {
            entity_id: e.currentTarget.dataset.duration,
          });
        } else if (action === "edit") {
          this._navigate(`/config/automation/edit/${e.currentTarget.dataset.editId}`);
        }
      });
    });
  }

  getCardSize() {
    return 2 + (this._config?.zones?.length || 0);
  }

  static getStubConfig() {
    return {
      title: "Irrigation Controls",
      zones: [
        {
          name: "Example Zone",
          automation: "automation.example",
          manual_switch: "switch.example",
          duration: "input_number.example",
          edit_id: "",
        },
      ],
    };
  }
}

customElements.define("irrigation-control-card", IrrigationControlCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "irrigation-control-card",
  name: "Irrigation Control Card",
  description: "Combined manual controls + live weekly schedule for irrigation zones",
});
