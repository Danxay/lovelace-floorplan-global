// Floorplan anti-flash fix v11
// v8: patches hass setter + independent cache bootstrap for reliable activation.
// v9: adds in-widget entity picker — gear button, config mode, popup with searchable dropdown.
// v10: stores overrides in the shared floorplan_global backend when available, with
//      fallback to legacy frontend user data for local/dev installs.
// v11: adds custom group popups for multi-light points while keeping single-entity
//      points on the standard Home Assistant more-info dialog.
const FLOORPLAN_MODULE_URL = import.meta.url;

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────
  var OVERRIDES_KEY = 'floorplan_entity_overrides';
  var CONFIG_MODE_CLASS = 'fp-config-mode';
  var GLOBAL_GET_OVERRIDES_WS_TYPE = 'floorplan_global/get_overrides';
  var GLOBAL_SET_OVERRIDES_WS_TYPE = 'floorplan_global/set_overrides';
  var WIDGET_SPEC_URL = new URL('widget_spec.json', FLOORPLAN_MODULE_URL).toString();
  var GROUP_POPUP_HOLD_MS = 420;
  var groupPopupState = null;

  // ─── Utility: shadow DOM traversal ──────────────────────────────────
  function findInShadow(root, selector) {
    if (!root) return null;
    var el = root.querySelector(selector);
    if (el) return el;
    for (var i = 0; i < root.querySelectorAll('*').length; i++) {
      var e = root.querySelectorAll('*')[i];
      if (e.shadowRoot) {
        var r = findInShadow(e.shadowRoot, selector);
        if (r) return r;
      }
    }
    return null;
  }

  // ─── Storage: HA frontend/set_user_data ─────────────────────────────
  function loadLegacyOverrides(hass) {
    if (!hass || !hass.callWS) return Promise.resolve({});
    return hass.callWS({ type: 'frontend/get_user_data', key: OVERRIDES_KEY })
      .then(function (result) {
        return (result && result.value) ? result.value : {};
      })
      .catch(function () { return {}; });
  }

  function saveLegacyOverrides(hass, data) {
    if (!hass || !hass.callWS) return Promise.resolve();
    return hass.callWS({ type: 'frontend/set_user_data', key: OVERRIDES_KEY, value: data })
      .catch(function (err) { console.warn('FLOORPLAN-FIX: failed to save overrides', err); });
  }

  function loadOverrides(hass) {
    if (!hass || !hass.callWS) return Promise.resolve({});
    return hass.callWS({ type: GLOBAL_GET_OVERRIDES_WS_TYPE })
      .then(function (result) {
        return (result && result.overrides) ? result.overrides : {};
      })
      .catch(function () {
        return loadLegacyOverrides(hass);
      });
  }

  function saveOverrides(hass, data) {
    if (!hass || !hass.callWS) return Promise.resolve();
    return hass.callWS({ type: GLOBAL_SET_OVERRIDES_WS_TYPE, overrides: data })
      .catch(function () {
        return saveLegacyOverrides(hass, data);
      });
  }

  // ─── Light group management via HA config entries API ───────────────

  // Create a new light group, returns { entry_id, entity_id }
  function createLightGroup(hass, name, entities) {
    return hass.callApi('POST', 'config/config_entries/flow', {
      handler: 'group', show_advanced_options: false
    }).then(function (step1) {
      return hass.callApi('POST', 'config/config_entries/flow/' + step1.flow_id, {
        next_step_id: 'light'
      });
    }).then(function (step2) {
      return hass.callApi('POST', 'config/config_entries/flow/' + step2.flow_id, {
        name: name, entities: entities, hide_members: false, all: false
      });
    }).then(function (result) {
      var entryId = result.result && result.result.entry_id;
      // Derive entity_id from name (HA converts to snake_case)
      var entityId = 'light.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      return { entry_id: entryId, entity_id: entityId };
    });
  }

  // Update entities in an existing light group
  function updateLightGroup(hass, entryId, entities) {
    return hass.callApi('POST', 'config/config_entries/options/flow', {
      handler: entryId
    }).then(function (step) {
      return hass.callApi('POST', 'config/config_entries/options/flow/' + step.flow_id, {
        entities: entities, hide_members: false, all: false
      });
    });
  }

  // Delete a light group config entry
  function deleteLightGroup(hass, entryId) {
    return hass.callApi('DELETE', 'config/config_entries/entry/' + entryId)
      .catch(function (err) { console.warn('FLOORPLAN-FIX: failed to delete group', err); });
  }

  // Create or update a light group for a floorplan point
  // Returns promise with { entry_id, entity_id }
  function ensureLightGroup(hass, origKey, members, existingEntryId) {
    var groupName = 'FP ' + origKey.replace(/^light\./, '').replace(/_/g, ' ');
    if (existingEntryId) {
      return updateLightGroup(hass, existingEntryId, members).then(function () {
        var entityId = 'light.fp_' + origKey.replace(/^light\./, '').replace(/[^a-z0-9]+/g, '_');
        return { entry_id: existingEntryId, entity_id: entityId };
      });
    }
    return createLightGroup(hass, groupName, members);
  }

  // ─── CSS for config mode + popup + device points ────────────────────
  var FP_STYLES = '.' + CONFIG_MODE_CLASS + ' button-card{animation:fp-glow 2s ease-in-out infinite;border-radius:50%}' +
    '@keyframes fp-glow{0%,100%{box-shadow:0 0 0 2.5px #4287f5,0 0 8px rgba(66,135,245,.25)}50%{box-shadow:0 0 0 3.5px #4287f5,0 0 14px rgba(66,135,245,.35)}}' +
    '.fp-gear-btn{position:absolute;bottom:10px;right:10px;width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,.08);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:100;transition:all .25s cubic-bezier(.4,0,.2,1);-webkit-tap-highlight-color:transparent}' +
    '.fp-gear-btn:hover{background:rgba(255,255,255,.15);border-color:rgba(255,255,255,.2);transform:rotate(30deg)}' +
    '.fp-gear-btn.active{background:#4287f5;border-color:#4287f5;box-shadow:0 0 20px rgba(66,135,245,.4)}' +
    '.fp-gear-btn svg{width:20px;height:20px;fill:rgba(255,255,255,.55);transition:fill .2s,transform .3s}' +
    '.fp-gear-btn:hover svg{fill:rgba(255,255,255,.85)}.fp-gear-btn.active svg{fill:#fff;transform:rotate(60deg)}' +
    '.fp-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;animation:fp-fade-in .2s ease-out;font-family:var(--ha-card-header-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif)}' +
    '@keyframes fp-fade-in{from{opacity:0}to{opacity:1}}' +
    '.fp-popup{background:#1c1c1c;border-radius:28px;width:min(420px,92vw);max-height:85vh;overflow-y:auto;color:#e1e1e1;box-shadow:0 12px 48px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);padding:0;animation:fp-popup-in .25s cubic-bezier(.4,0,.2,1)}' +
    '@keyframes fp-popup-in{from{opacity:0;transform:scale(.95) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}' +
    '.fp-popup::-webkit-scrollbar{width:4px}.fp-popup::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}.fp-popup::-webkit-scrollbar-track{background:transparent}' +
    '.fp-popup-header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px 16px}' +
    '.fp-popup-header h3{margin:0;font-size:18px;font-weight:400;color:#fff;letter-spacing:-.01em}' +
    '.fp-popup-close{background:rgba(255,255,255,.06);border:none;cursor:pointer;color:rgba(255,255,255,.5);width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;transition:all .15s}' +
    '.fp-popup-close:hover{background:rgba(255,255,255,.12);color:#fff}' +
    '.fp-popup-body{padding:4px 24px 24px}' +
    '.fp-label{font-size:12px;font-weight:500;letter-spacing:.02em;color:rgba(255,255,255,.5);margin-bottom:8px;margin-top:20px}.fp-label:first-child{margin-top:0}' +
    '.fp-entity-input-wrap{position:relative}' +
    '.fp-entity-input{width:100%;box-sizing:border-box;padding:12px 16px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.15);border-radius:12px;color:#e1e1e1;font-size:14px;font-family:var(--code-font-family,"SF Mono","Fira Code","Roboto Mono",monospace);outline:none;transition:border-color .2s,background .2s,box-shadow .2s}' +
    '.fp-entity-input:focus{border-color:#4287f5;background:rgba(255,255,255,.07);box-shadow:0 0 0 1px #4287f5}' +
    '.fp-entity-input::placeholder{color:rgba(255,255,255,.2)}' +
    '.fp-dropdown{position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:220px;overflow-y:auto;background:#252525;border:1px solid rgba(255,255,255,.1);border-radius:14px;z-index:10;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:4px;animation:fp-dropdown-in .15s ease-out}' +
    '@keyframes fp-dropdown-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}' +
    '.fp-dropdown::-webkit-scrollbar{width:4px}.fp-dropdown::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}.fp-dropdown::-webkit-scrollbar-track{background:transparent}' +
    '.fp-dropdown-item{padding:8px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:13px;border-radius:10px;transition:background .1s}' +
    '.fp-dropdown-item:hover,.fp-dropdown-item.fp-dd-active{background:rgba(255,255,255,.08)}' +
    '.fp-dropdown-item .fp-dd-id{font-family:var(--code-font-family,"SF Mono","Fira Code",monospace);color:#e1e1e1;font-size:12px}' +
    '.fp-dropdown-item .fp-dd-name{color:rgba(255,255,255,.4);font-size:11px;margin-left:10px;flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.fp-dropdown-domain{padding:8px 12px 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.35);pointer-events:none}' +
    '.fp-member-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.fp-member-row .fp-entity-input-wrap{flex:1}' +
    '.fp-member-remove{background:rgba(255,255,255,.05);border:none;cursor:pointer;color:rgba(255,100,100,.7);width:36px;height:36px;min-width:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;transition:all .15s}' +
    '.fp-member-remove:hover{color:#ff6464;background:rgba(255,80,80,.12)}' +
    '.fp-add-member{background:rgba(255,255,255,.04);border:1.5px dashed rgba(255,255,255,.12);border-radius:12px;color:rgba(66,135,245,.9);padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;width:100%;text-align:center;transition:all .15s}' +
    '.fp-add-member:hover{background:rgba(66,135,245,.08);border-color:rgba(66,135,245,.3)}' +
    '.fp-popup-actions{display:flex;gap:10px;margin-top:24px}' +
    '.fp-btn{flex:1;padding:12px 16px;border:none;border-radius:12px;font-size:14px;font-weight:500;cursor:pointer;transition:all .2s cubic-bezier(.4,0,.2,1);letter-spacing:.01em}.fp-btn:active{transform:scale(.97)}' +
    '.fp-btn-primary{background:#4287f5;color:#fff;box-shadow:0 2px 8px rgba(66,135,245,.3)}.fp-btn-primary:hover{filter:brightness(1.1);box-shadow:0 4px 14px rgba(66,135,245,.4)}' +
    '.fp-btn-secondary{background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)}.fp-btn-secondary:hover{background:rgba(255,255,255,.12);color:#fff}' +
    '.fp-override-badge{position:absolute;top:-2px;right:-2px;width:7px;height:7px;background:#4287f5;border-radius:50%;border:1.5px solid #1c1c1c;pointer-events:none;box-shadow:0 0 4px rgba(66,135,245,.5)}' +
    '.fp-group-overlay{position:fixed;inset:0;background:rgba(0,0,0,.64);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;animation:fp-fade-in .2s ease-out;font-family:var(--ha-card-header-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif)}' +
    '.fp-group-popup{background:var(--dialog-surface-background,#1c1c1c);border-radius:28px;width:min(760px,96vw);max-height:88vh;overflow-y:auto;color:var(--primary-text-color,#fff);box-shadow:0 24px 60px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06);animation:fp-popup-in .22s cubic-bezier(.4,0,.2,1)}' +
    '.fp-group-popup::-webkit-scrollbar{width:4px}.fp-group-popup::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}.fp-group-popup::-webkit-scrollbar-track{background:transparent}' +
    '.fp-group-popup-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px 14px;border-bottom:1px solid rgba(255,255,255,.06)}' +
    '.fp-group-popup-title-wrap{display:flex;flex-direction:column;gap:4px;min-width:0}' +
    '.fp-group-popup-title{font-size:18px;font-weight:500;letter-spacing:-.01em;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.fp-group-popup-subtitle{font-size:12px;color:rgba(255,255,255,.46)}' +
    '.fp-group-popup-close{background:rgba(255,255,255,.06);border:none;cursor:pointer;color:rgba(255,255,255,.56);width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;transition:all .15s}.fp-group-popup-close:hover{background:rgba(255,255,255,.12);color:#fff}' +
    '.fp-group-popup-body{padding:18px 22px 22px;display:flex;flex-direction:column;gap:16px}' +
    '.fp-group-section{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:22px;overflow:hidden}' +
    '.fp-group-section-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px 12px}' +
    '.fp-group-section-title{font-size:15px;font-weight:500;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.fp-group-section-meta{font-size:12px;color:rgba(255,255,255,.42);font-family:var(--code-font-family,"SF Mono","Fira Code",monospace)}' +
    '.fp-group-section-content{padding:0 8px 8px}.fp-group-section-content > *{display:block}' +
    '.fp-group-section-content more-info-light,.fp-group-section-content more-info-content{display:block}' +
    '.fp-group-fallback{padding:0 14px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;color:rgba(255,255,255,.72)}' +
    '.fp-group-fallback button{background:#4287f5;color:#fff;border:none;border-radius:12px;padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500}';

  // ─── SVG icons ──────────────────────────────────────────────────────
  var GEAR_SVG = '<svg viewBox="0 0 24 24"><path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64L19.43 12.97Z"/></svg>';

  // ─── Entity picker popup ────────────────────────────────────────────

  // Build sorted entity list from hass.states, grouped by domain
  function getEntityList(hass) {
    if (!hass || !hass.states) return [];
    var keys = Object.keys(hass.states);
    keys.sort(function (a, b) {
      var da = a.split('.')[0], db = b.split('.')[0];
      if (da !== db) return da.localeCompare(db);
      return a.localeCompare(b);
    });
    return keys;
  }

  // Create a searchable entity input with dropdown
  function createEntityInput(container, hass, initialValue, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'fp-entity-input-wrap';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'fp-entity-input';
    input.placeholder = 'entity_id...';
    input.value = initialValue || '';
    input.autocomplete = 'off';
    wrap.appendChild(input);

    var dropdown = null;
    var activeIdx = -1;
    var filteredItems = [];

    function closeDropdown() {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
      }
      activeIdx = -1;
      filteredItems = [];
    }

    function renderDropdown(filter) {
      closeDropdown();
      var allEntities = getEntityList(hass);
      var lowerFilter = (filter || '').toLowerCase();

      // Filter
      filteredItems = allEntities.filter(function (eid) {
        if (!lowerFilter) return true;
        var name = (hass.states[eid].attributes.friendly_name || '').toLowerCase();
        return eid.toLowerCase().indexOf(lowerFilter) >= 0 || name.indexOf(lowerFilter) >= 0;
      });

      if (filteredItems.length === 0) return;
      if (filteredItems.length > 80) filteredItems = filteredItems.slice(0, 80);

      dropdown = document.createElement('div');
      dropdown.className = 'fp-dropdown';

      var lastDomain = '';
      filteredItems.forEach(function (eid, idx) {
        var domain = eid.split('.')[0];
        if (domain !== lastDomain) {
          var domLabel = document.createElement('div');
          domLabel.className = 'fp-dropdown-domain';
          domLabel.textContent = domain;
          dropdown.appendChild(domLabel);
          lastDomain = domain;
        }
        var item = document.createElement('div');
        item.className = 'fp-dropdown-item';
        item.dataset.idx = idx;
        var idSpan = document.createElement('span');
        idSpan.className = 'fp-dd-id';
        idSpan.textContent = eid;
        var nameSpan = document.createElement('span');
        nameSpan.className = 'fp-dd-name';
        nameSpan.textContent = hass.states[eid].attributes.friendly_name || '';
        item.appendChild(idSpan);
        item.appendChild(nameSpan);
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          input.value = eid;
          closeDropdown();
          if (onChange) onChange(eid);
        });
        dropdown.appendChild(item);
      });
      wrap.appendChild(dropdown);
    }

    function highlightActive() {
      if (!dropdown) return;
      var items = dropdown.querySelectorAll('.fp-dropdown-item');
      items.forEach(function (it, i) {
        it.classList.toggle('fp-dd-active', parseInt(it.dataset.idx) === activeIdx);
      });
      // Scroll into view
      if (activeIdx >= 0) {
        var active = dropdown.querySelector('.fp-dd-active');
        if (active) active.scrollIntoView({ block: 'nearest' });
      }
    }

    input.addEventListener('focus', function () {
      renderDropdown(input.value);
    });

    input.addEventListener('input', function () {
      activeIdx = -1;
      renderDropdown(input.value);
      if (onChange) onChange(input.value);
    });

    input.addEventListener('blur', function () {
      // Delay to allow mousedown on dropdown item
      setTimeout(closeDropdown, 150);
    });

    input.addEventListener('keydown', function (e) {
      if (!dropdown) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, filteredItems.length - 1);
        highlightActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        highlightActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < filteredItems.length) {
          input.value = filteredItems[activeIdx];
          closeDropdown();
          if (onChange) onChange(input.value);
        }
      } else if (e.key === 'Escape') {
        closeDropdown();
        input.blur();
      }
    });

    container.appendChild(wrap);
    return {
      el: wrap,
      getValue: function () { return input.value.trim(); },
      setValue: function (v) { input.value = v || ''; },
      input: input
    };
  }

  // Show the entity picker popup for a button-card
  function showEntityPicker(btn, hass, ctcEl) {
    // Close existing popup if any
    var existing = document.querySelector('.fp-overlay');
    if (existing) existing.remove();

    var origKey = btn._fpOrigKey;
    var currentConfig = btn._config || {};
    var vars = currentConfig.variables || {};
    var currentPrimary = vars.primary_entity || '';
    var currentMembers = (vars.members || []).slice();
    var currentGroup = vars.group_entity || '';

    // State
    var state = {
      primary: currentPrimary,
      members: currentMembers.slice(),
      group: currentGroup
    };

    // Create overlay
    var overlay = document.createElement('div');
    overlay.className = 'fp-overlay';

    var popup = document.createElement('div');
    popup.className = 'fp-popup';

    // Prevent clicks on popup from closing
    popup.addEventListener('click', function (e) { e.stopPropagation(); });
    popup.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    // Header
    var header = document.createElement('div');
    header.className = 'fp-popup-header';
    var title = document.createElement('h3');
    title.textContent = 'Настройка точки';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'fp-popup-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    // Body
    var body = document.createElement('div');
    body.className = 'fp-popup-body';

    // Primary entity
    var lbl1 = document.createElement('div');
    lbl1.className = 'fp-label';
    lbl1.textContent = 'Entity для отображения';
    body.appendChild(lbl1);
    var primaryInput = createEntityInput(body, hass, state.primary, function (v) {
      state.primary = v;
    });

    // Members
    var lbl2 = document.createElement('div');
    lbl2.className = 'fp-label';
    lbl2.textContent = 'Устройства для управления (tap)';
    body.appendChild(lbl2);

    var membersContainer = document.createElement('div');
    membersContainer.className = 'fp-members-container';
    body.appendChild(membersContainer);

    var memberInputs = [];

    function renderMembers() {
      membersContainer.innerHTML = '';
      memberInputs = [];
      state.members.forEach(function (memberId, idx) {
        var row = document.createElement('div');
        row.className = 'fp-member-row';
        var mi = createEntityInput(row, hass, memberId, function (v) {
          state.members[idx] = v;
        });
        memberInputs.push(mi);
        var removeBtn = document.createElement('button');
        removeBtn.className = 'fp-member-remove';
        removeBtn.innerHTML = '&times;';
        removeBtn.addEventListener('click', function () {
          state.members.splice(idx, 1);
          renderMembers();
        });
        row.appendChild(removeBtn);
        membersContainer.appendChild(row);
      });

      // Add member button
      var addBtn = document.createElement('button');
      addBtn.className = 'fp-add-member';
      addBtn.textContent = '+ Добавить';
      addBtn.addEventListener('click', function () {
        state.members.push('');
        renderMembers();
        // Focus the new input
        var last = memberInputs[memberInputs.length - 1];
        if (last) last.input.focus();
      });
      membersContainer.appendChild(addBtn);
    }
    renderMembers();

    // Group entity
    var lbl3 = document.createElement('div');
    lbl3.className = 'fp-label';
    lbl3.textContent = 'Entity для настроек (hold)';
    body.appendChild(lbl3);
    var groupInput = createEntityInput(body, hass, state.group, function (v) {
      state.group = v;
    });

    // Info text
    var info = document.createElement('div');
    info.style.cssText = 'font-size:11px; color:rgba(255,255,255,0.3); margin-top:12px;';
    info.textContent = 'Оставьте пустым для значений по умолчанию';
    body.appendChild(info);

    // Action buttons
    var actions = document.createElement('div');
    actions.className = 'fp-popup-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'fp-btn fp-btn-secondary';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.addEventListener('click', function () {
      overlay.remove();
    });

    var applyBtn = document.createElement('button');
    applyBtn.className = 'fp-btn fp-btn-primary';
    applyBtn.textContent = 'Применить';
    applyBtn.addEventListener('click', function () {
      var newPrimary = primaryInput.getValue();
      var newMembers = [];
      memberInputs.forEach(function (mi) {
        var v = mi.getValue();
        if (v) newMembers.push(v);
      });
      var newGroup = groupInput.getValue();

      if (!newPrimary) {
        primaryInput.input.style.borderColor = 'rgba(255,100,100,0.6)';
        setTimeout(function () { primaryInput.input.style.borderColor = ''; }, 1500);
        return;
      }
      if (newMembers.length === 0) {
        newMembers = [newPrimary];
      }

      // Disable button while saving
      applyBtn.disabled = true;
      applyBtn.textContent = '...';

      var overrides = ctcEl._fpOverrides || {};
      var existingOverride = overrides[origKey] || {};

      // Auto light group logic:
      // If 2+ members → create/update a light group for the hold popup
      // If 1 member → delete auto group if it existed, use primary as group_entity
      var groupPromise;
      if (newMembers.length >= 2) {
        var existingEntryId = existingOverride.auto_group_entry_id || null;
        groupPromise = ensureLightGroup(hass, origKey, newMembers, existingEntryId)
          .then(function (groupInfo) {
            // If user didn't manually set a group, use the auto-created one
            if (!newGroup || newGroup === existingOverride.auto_group_entity_id) {
              newGroup = groupInfo.entity_id;
            }
            return { entry_id: groupInfo.entry_id, entity_id: groupInfo.entity_id };
          })
          .catch(function (err) {
            console.warn('FLOORPLAN-FIX: auto group creation failed', err);
            return null;
          });
      } else {
        // Single member — delete auto group if existed
        if (existingOverride.auto_group_entry_id) {
          deleteLightGroup(hass, existingOverride.auto_group_entry_id);
        }
        if (!newGroup) newGroup = newPrimary;
        groupPromise = Promise.resolve(null);
      }

      groupPromise.then(function (autoGroup) {
        // Apply to button
        applyOverrideToButton(btn, newPrimary, newMembers, newGroup, hass);

        // Save override
        var overrideData = {
          primary_entity: newPrimary,
          members: newMembers,
          group_entity: newGroup
        };
        if (autoGroup) {
          overrideData.auto_group_entry_id = autoGroup.entry_id;
          overrideData.auto_group_entity_id = autoGroup.entity_id;
        }
        overrides[origKey] = overrideData;
        ctcEl._fpOverrides = overrides;
        saveOverrides(hass, overrides);

        updateBadge(btn, true);
        overlay.remove();
      });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(applyBtn);
    body.appendChild(actions);

    popup.appendChild(body);
    overlay.appendChild(popup);

    // Close on overlay click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  // Apply entity override to a button-card instance.
  // IMPORTANT: We build a MINIMAL config with the template reference (e.g. ['group_point'])
  // so button-card re-merges the template and re-evaluates [[[...]]] expressions.
  // Cloning btn._config doesn't work — it has already-resolved template expressions.
  // Position styles are saved/restored because picture-elements sets them on the element.
  function applyOverrideToButton(btn, primary, members, group, hass) {
    try {
      if (!btn._config) return;

      // Save position styles set by picture-elements
      var savedLeft = btn.style.left;
      var savedTop = btn.style.top;
      var savedPosition = btn.style.position;
      var savedTransform = btn.style.transform;

      // Build minimal unmerged config — only per-instance fields + template reference.
      // button-card will merge the template definition (group_point) and get fresh [[[...]]]
      var prevVars = btn._config.variables || {};
      var newVars = {
        primary_entity: primary,
        members: members,
        point_label: prevVars.point_label || '',
        use_group_popup: prevVars.use_group_popup || false
      };
      if (group) newVars.group_entity = group;
      var triggersUpdate = [];
      if (primary) triggersUpdate.push(primary);
      if (Array.isArray(members)) triggersUpdate = triggersUpdate.concat(members);
      if (group) triggersUpdate.push(group);
      triggersUpdate = Array.from(new Set(triggersUpdate.filter(Boolean)));

      var newConfig = {
        type: btn._config.type || 'custom:button-card',
        entity: primary,
        template: btn._config.template,  // e.g. ['group_point']
        icon: btn._config.icon,
        variables: newVars,
        triggers_update: triggersUpdate
      };

      btn.setConfig(newConfig);

      // Restore position immediately
      btn.style.left = savedLeft;
      btn.style.top = savedTop;
      btn.style.position = savedPosition;
      btn.style.transform = savedTransform;

      if (hass) btn.hass = hass;

      // Also restore after async render (button-card may overwrite styles)
      requestAnimationFrame(function () {
        btn.style.left = savedLeft;
        btn.style.top = savedTop;
        btn.style.position = savedPosition;
        btn.style.transform = savedTransform;
      });
    } catch (err) {
      console.warn('FLOORPLAN-FIX: failed to apply override', err);
    }
  }

  // Update (add/remove) override badge on a button
  // NOTE: Do NOT modify btn.style.position — picture-elements uses position:absolute
  // with left/top percentages. Overriding it breaks the point's location.
  function updateBadge(btn, show) {
    var existing = btn.querySelector('.fp-override-badge');
    if (show && !existing) {
      var badge = document.createElement('div');
      badge.className = 'fp-override-badge';
      btn.appendChild(badge);
    } else if (!show && existing) {
      existing.remove();
    }
  }

  function ensureDocumentStyles() {
    if (!document.querySelector('#fp-overlay-styles')) {
      var docStyle = document.createElement('style');
      docStyle.id = 'fp-overlay-styles';
      docStyle.textContent = FP_STYLES;
      document.head.appendChild(docStyle);
    }
  }

  function isLightGroupButton(btn) {
    var vars = btn && btn._config && btn._config.variables ? btn._config.variables : {};
    var members = vars.members || [];
    return Boolean(vars.use_group_popup) &&
      members.length > 1 &&
      members.every(function (id) { return typeof id === 'string' && id.indexOf('light.') === 0; });
  }

  function getGroupPopupTitle(btn, hass) {
    var vars = btn && btn._config && btn._config.variables ? btn._config.variables : {};
    var groupEntity = vars.group_entity;
    var pointLabel = vars.point_label;
    if (groupEntity && hass && hass.states[groupEntity] && hass.states[groupEntity].attributes &&
      hass.states[groupEntity].attributes.friendly_name) {
      return hass.states[groupEntity].attributes.friendly_name;
    }
    if (pointLabel) return pointLabel;
    if (vars.primary_entity && hass && hass.states[vars.primary_entity] &&
      hass.states[vars.primary_entity].attributes &&
      hass.states[vars.primary_entity].attributes.friendly_name) {
      return hass.states[vars.primary_entity].attributes.friendly_name;
    }
    return 'Light Group';
  }

  function closeGroupPopup() {
    if (!groupPopupState) return;
    if (groupPopupState.keyHandler) {
      document.removeEventListener('keydown', groupPopupState.keyHandler, true);
    }
    if (groupPopupState.overlay && groupPopupState.overlay.parentNode) {
      groupPopupState.overlay.parentNode.removeChild(groupPopupState.overlay);
    }
    groupPopupState = null;
  }

  function openNativeMoreInfo(entityId) {
    if (!entityId) return;
    var event = new CustomEvent('hass-more-info', {
      bubbles: true,
      composed: true,
      detail: { entityId: entityId }
    });
    var root = document.querySelector('home-assistant') || document.body;
    root.dispatchEvent(event);
  }

  function createGroupLightControl(entityId, hass) {
    var section = document.createElement('section');
    section.className = 'fp-group-section';

    var header = document.createElement('div');
    header.className = 'fp-group-section-header';

    var titleWrap = document.createElement('div');
    var title = document.createElement('div');
    title.className = 'fp-group-section-title';
    title.textContent = entityId;
    var meta = document.createElement('div');
    meta.className = 'fp-group-section-meta';
    meta.textContent = entityId;
    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    var openBtn = document.createElement('button');
    openBtn.className = 'fp-popup-close';
    openBtn.innerHTML = '&rsaquo;';
    openBtn.title = 'Open full controls';
    openBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeGroupPopup();
      openNativeMoreInfo(entityId);
    });

    header.appendChild(titleWrap);
    header.appendChild(openBtn);
    section.appendChild(header);

    var contentWrap = document.createElement('div');
    contentWrap.className = 'fp-group-section-content';
    section.appendChild(contentWrap);

    var contentEl = null;
    var tagName = 'more-info-light';
    if (customElements.get(tagName)) {
      contentEl = document.createElement(tagName);
      contentWrap.appendChild(contentEl);
    } else {
      var fallback = document.createElement('div');
      fallback.className = 'fp-group-fallback';
      fallback.innerHTML = '<span>Individual controls are not available yet.</span>';
      var fallbackBtn = document.createElement('button');
      fallbackBtn.textContent = 'Open';
      fallbackBtn.addEventListener('click', function () {
        closeGroupPopup();
        openNativeMoreInfo(entityId);
      });
      fallback.appendChild(fallbackBtn);
      contentWrap.appendChild(fallback);
    }

    return {
      entityId: entityId,
      section: section,
      titleEl: title,
      metaEl: meta,
      contentEl: contentEl
    };
  }

  function updateGroupPopup(hass) {
    if (!groupPopupState || !hass) return;
    groupPopupState.memberViews.forEach(function (view) {
      var stateObj = hass.states[view.entityId];
      view.titleEl.textContent = (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) || view.entityId;
      view.metaEl.textContent = view.entityId;
      if (view.contentEl) {
        view.contentEl.hass = hass;
        view.contentEl.stateObj = stateObj;
      }
    });
  }

  function showGroupPopup(btn, hass) {
    if (!hass || !isLightGroupButton(btn)) return;
    closeGroupPopup();
    ensureDocumentStyles();

    var vars = btn._config.variables || {};
    var members = (vars.members || []).filter(function (id) { return typeof id === 'string' && id.indexOf('light.') === 0; });
    if (!members.length) return;

    var overlay = document.createElement('div');
    overlay.className = 'fp-group-overlay';

    var popup = document.createElement('div');
    popup.className = 'fp-group-popup';
    popup.addEventListener('click', function (e) { e.stopPropagation(); });
    popup.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    var header = document.createElement('div');
    header.className = 'fp-group-popup-header';

    var titleWrap = document.createElement('div');
    titleWrap.className = 'fp-group-popup-title-wrap';
    var title = document.createElement('div');
    title.className = 'fp-group-popup-title';
    title.textContent = getGroupPopupTitle(btn, hass);
    var subtitle = document.createElement('div');
    subtitle.className = 'fp-group-popup-subtitle';
    subtitle.textContent = 'Manage each light in this group individually';
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'fp-group-popup-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () {
      closeGroupPopup();
    });

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    var body = document.createElement('div');
    body.className = 'fp-group-popup-body';
    var memberViews = members.map(function (entityId) {
      var view = createGroupLightControl(entityId, hass);
      body.appendChild(view.section);
      return view;
    });
    popup.appendChild(body);

    overlay.appendChild(popup);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeGroupPopup();
    });

    var keyHandler = function (e) {
      if (e.key === 'Escape') closeGroupPopup();
    };
    document.addEventListener('keydown', keyHandler, true);
    document.body.appendChild(overlay);

    groupPopupState = {
      overlay: overlay,
      keyHandler: keyHandler,
      memberViews: memberViews
    };
    updateGroupPopup(hass);
  }

  function initGroupPopupHandling(ctcEl) {
    if (ctcEl._fpGroupPopupInited) return;
    ctcEl._fpGroupPopupInited = true;
    ensureDocumentStyles();

    ctcEl._fpButtons.forEach(function (btn) {
      if (btn._fpGroupPopupBound) return;
      btn._fpGroupPopupBound = true;

      var holdTimer = null;
      var suppressClick = false;

      var clearHoldTimer = function () {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      };

      var startHoldTimer = function (e) {
        if (ctcEl._fpConfigMode || !isLightGroupButton(btn)) return;
        if (e.type === 'mousedown' && e.button !== 0) return;
        clearHoldTimer();
        holdTimer = setTimeout(function () {
          holdTimer = null;
          suppressClick = true;
          showGroupPopup(btn, ctcEl.hass);
        }, GROUP_POPUP_HOLD_MS);
      };

      btn.addEventListener('pointerdown', startHoldTimer, true);
      btn.addEventListener('pointerup', clearHoldTimer, true);
      btn.addEventListener('pointerleave', clearHoldTimer, true);
      btn.addEventListener('pointercancel', clearHoldTimer, true);
      btn.addEventListener('touchstart', startHoldTimer, true);
      btn.addEventListener('touchend', clearHoldTimer, true);
      btn.addEventListener('touchcancel', clearHoldTimer, true);
      btn.addEventListener('mousedown', startHoldTimer, true);
      btn.addEventListener('mouseup', clearHoldTimer, true);

      btn.addEventListener('click', function (e) {
        if (!suppressClick) return;
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, true);
    });
  }

  // ─── Core: patch config-template-card ───────────────────────────────
  function patchCTC() {
    var ctcDef = customElements.get('config-template-card');
    if (!ctcDef) return false;

    var proto = ctcDef.prototype;
    if (proto._fpPatched) return true;

    var hassDesc = Object.getOwnPropertyDescriptor(proto, 'hass');
    if (!hassDesc || !hassDesc.set) return false;

    var origShouldUpdate = proto.shouldUpdate;
    var origHassSetter = hassDesc.set;

    proto._fpTryCache = function () {
      if (this._fpReady) return true;
      if (!this.shadowRoot) return false;

      var card = this.shadowRoot.querySelector('hui-picture-elements-card');
      if (!card || !card.shadowRoot) return false;
      var haCard = card.shadowRoot.querySelector('ha-card');
      if (!haCard) return false;
      var root = haCard.querySelector('#root');
      if (!root) return false;

      // Cache hui-image-element elements (the light overlays)
      var imageEls = root.querySelectorAll('hui-image-element');
      if (imageEls.length === 0) return false;

      this._fpImages = [];
      var self = this;
      imageEls.forEach(function (el) {
        var entity = (el._config && el._config.entity) || '';
        if (entity) {
          // Find the actual <img> inside shadow DOM for direct style control
          var img = null;
          if (el.shadowRoot) {
            img = el.shadowRoot.querySelector('img') ||
                  (el.shadowRoot.querySelector('ha-image') &&
                   el.shadowRoot.querySelector('ha-image').shadowRoot &&
                   el.shadowRoot.querySelector('ha-image').shadowRoot.querySelector('img'));
          }
          self._fpImages.push({ el: el, img: img, entity: entity });
        }
      });

      // Cache button-card elements
      this._fpButtons = Array.from(root.querySelectorAll('button-card'));
      this._fpRoot = root;
      this._fpHaCard = haCard;

      // Store original configs for override capability
      this._fpOriginalConfigs = {};
      this._fpButtons.forEach(function (btn) {
        var pe = btn._config?.variables?.primary_entity;
        if (pe) {
          btn._fpOrigKey = pe;
          self._fpOriginalConfigs[pe] = JSON.parse(JSON.stringify(btn._config));
        }
      });

      // Load opacity scale from widget_spec if available
      this._fpOpacityScale = {};
      try {
        var specResp = new XMLHttpRequest();
        specResp.open('GET', WIDGET_SPEC_URL, false);
        specResp.send();
        if (specResp.status === 200) {
          var spec = JSON.parse(specResp.responseText);
          this._fpOpacityScale = (spec.build && spec.build.opacity_scale) || {};
        }
      } catch (e) { /* widget_spec not available, skip */ }

      this._fpReady = this._fpImages.length > 0;
      if (this._fpReady) {
        console.info('FLOORPLAN-FIX: cached', this._fpImages.length,
          'image overlays,', this._fpButtons.length, 'buttons — flash disabled');
        initGroupPopupHandling(this);
        // Initialize config mode features
        initConfigMode(this);
        // Load and apply overrides
        loadAndApplyOverrides(this);
      }
      return this._fpReady;
    };

    proto._fpUpdateStyles = function () {
      if (!this._fpReady || !this.hass) return;
      var states = this.hass.states;

      var opacityScale = (this._fpOpacityScale) || {};
      this._fpImages.forEach(function (item) {
        var el = item.el;
        if (!el.parentNode) return;
        var entity = item.entity;
        var state = states[entity];
        if (!state) return;

        var attrs = state.attributes;
        var filter, opacity;

        if (attrs.brightness !== undefined) {
          opacity = state.state === 'on'
            ? ((attrs.brightness || 255) / 255)
            : 0;
          var scale = opacityScale[entity];
          if (scale) opacity *= scale;

          var hsColor = attrs.hs_color;
          var colorMode = attrs.color_mode;
          var ctk = attrs.color_temp_kelvin;
          if (!ctk && attrs.color_temp) ctk = Math.round(1000000 / attrs.color_temp);

          if (colorMode === 'color_temp' && ctk) {
            var t = Math.max(0, Math.min(1, (ctk - 2000) / (6500 - 2000)));
            filter = 'hue-rotate(' + (t * -15) + 'deg) saturate(' + (0.53 - t * 0.45).toFixed(2) + ')';
          } else if (hsColor && hsColor.length >= 2 && (hsColor[0] || hsColor[1])) {
            filter = 'hue-rotate(' + (hsColor[0] - 42) + 'deg) saturate(' + Math.max(0.1, hsColor[1] / 35).toFixed(2) + ')';
          } else if (ctk) {
            var t2 = Math.max(0, Math.min(1, (ctk - 2000) / (6500 - 2000)));
            filter = 'hue-rotate(' + (t2 * -15) + 'deg) saturate(' + (0.53 - t2 * 0.45).toFixed(2) + ')';
          } else {
            filter = 'saturate(0.35)';
          }
        } else {
          opacity = state.state === 'on' ? 1 : 0;
          filter = 'saturate(0.35)';
        }

        el.style.opacity = opacity;
        el.style.filter = filter;
      });

      var hass = this.hass;
      this._fpButtons.forEach(function (btn) {
        btn.hass = hass;
      });

      updateGroupPopup(hass);
      initGroupPopupHandling(this);

      if (!this._fpConfigInited && this.hass.user && this.hass.user.is_admin) {
        initConfigMode(this);
      }
    };

    // Schedule a deferred style update to overwrite any async template re-renders
    proto._fpDeferredUpdate = function () {
      var self = this;
      if (self._fpRafId) cancelAnimationFrame(self._fpRafId);
      self._fpRafId = requestAnimationFrame(function () {
        self._fpRafId = null;
        self._fpUpdateStyles();
      });
    };

    proto.shouldUpdate = function (changedProps) {
      if (!this._initialized) this._initialize();
      this._fpTryCache();
      if (!this._fpReady) {
        return origShouldUpdate.call(this, changedProps);
      }
      this._fpUpdateStyles();
      this._fpDeferredUpdate();
      return false;
    };

    Object.defineProperty(proto, 'hass', {
      get: hassDesc.get,
      set: function (value) {
        origHassSetter.call(this, value);
        if (this._fpReady) {
          this._fpUpdateStyles();
          this._fpDeferredUpdate();
        }
      },
      configurable: true,
      enumerable: true
    });

    proto._fpPatched = true;
    console.info(
      '%c FLOORPLAN-FIX %c v11 — zero-flash + entity picker + group popup',
      'color: orange; font-weight: bold;', ''
    );
    return true;
  }

  // ─── Config mode initialization ─────────────────────────────────────
  function initConfigMode(ctcEl) {
    if (ctcEl._fpConfigInited) return;
    if (!ctcEl.hass || !ctcEl.hass.user || !ctcEl.hass.user.is_admin) return;
    ctcEl._fpConfigInited = true;
    ctcEl._fpConfigMode = false;

    var root = ctcEl._fpRoot;
    var haCard = ctcEl._fpHaCard;

    // Inject styles into the ha-card's parent shadow root
    var cardShadow = haCard.getRootNode();
    if (cardShadow && !cardShadow.querySelector('#fp-config-styles')) {
      var style = document.createElement('style');
      style.id = 'fp-config-styles';
      style.textContent = FP_STYLES;
      cardShadow.appendChild(style);
    }

    // Also inject styles into document head for the overlay
    if (!document.querySelector('#fp-overlay-styles')) {
      var docStyle = document.createElement('style');
      docStyle.id = 'fp-overlay-styles';
      docStyle.textContent = FP_STYLES;
      document.head.appendChild(docStyle);
    }

    // Create gear button
    var gear = document.createElement('div');
    gear.className = 'fp-gear-btn';
    gear.innerHTML = GEAR_SVG;
    gear.title = 'Настройка entity';
    gear.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      ctcEl._fpConfigMode = !ctcEl._fpConfigMode;
      gear.classList.toggle('active', ctcEl._fpConfigMode);
      root.classList.toggle(CONFIG_MODE_CLASS, ctcEl._fpConfigMode);
    });
    root.appendChild(gear);

    // Attach click interceptors on button-cards
    ctcEl._fpButtons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (!ctcEl._fpConfigMode) return;
        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();
        showEntityPicker(btn, ctcEl.hass, ctcEl);
      }, true); // capture phase
    });
  }

  // ─── Load overrides from HA and apply ───────────────────────────────
  function loadAndApplyOverrides(ctcEl) {
    if (!ctcEl.hass) return;
    loadOverrides(ctcEl.hass).then(function (overrides) {
      if (!overrides || Object.keys(overrides).length === 0) return;
      ctcEl._fpOverrides = overrides;
      var hass = ctcEl.hass;
      ctcEl._fpButtons.forEach(function (btn) {
        var origKey = btn._fpOrigKey;
        if (origKey && overrides[origKey]) {
          var ov = overrides[origKey];
          applyOverrideToButton(btn, ov.primary_entity, ov.members || [], ov.group_entity || '', hass);
          updateBadge(btn, true);
        }
      });
      console.info('FLOORPLAN-FIX: applied', Object.keys(overrides).length, 'entity overrides');
    });
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────
  function bootstrapCache() {
    var ctcEl = findInShadow(document, 'config-template-card');
    if (!ctcEl) return false;
    if (ctcEl._fpReady) return true;
    if (!ctcEl._fpTryCache || !ctcEl._fpTryCache()) return false;
    if (ctcEl._fpUpdateStyles) ctcEl._fpUpdateStyles();
    return true;
  }

  function startCacheBootstrap() {
    if (bootstrapCache()) return;
    var bc = 0;
    var bcIv = setInterval(function () {
      if (bootstrapCache() || ++bc > 60) clearInterval(bcIv);
    }, 500);
  }

  function styleView() {
    var panelView = findInShadow(document, 'hui-panel-view');
    if (!panelView) return false;
    var pvSR = panelView.shadowRoot;
    if (!pvSR) return false;
    if (!pvSR.querySelector('#fp-center-style')) {
      var style = document.createElement('style');
      style.id = 'fp-center-style';
      style.textContent = ':host { display: flex !important; flex-direction: column !important; justify-content: center !important; min-height: calc(100vh - var(--header-height, 56px)) !important; background: #1F2020 !important; }';
      pvSR.appendChild(style);
    }
    var huiCard = pvSR.querySelector('hui-card');
    if (huiCard) {
      huiCard.style.background = '#1F2020';
    }
    return true;
  }

  // ─── Init ───────────────────────────────────────────────────────────
  if (patchCTC()) {
    startCacheBootstrap();
  } else {
    var n = 0;
    var iv = setInterval(function () {
      if (patchCTC()) {
        clearInterval(iv);
        startCacheBootstrap();
      } else if (++n > 60) {
        clearInterval(iv);
      }
    }, 500);
  }

  var sv = 0;
  var svIv = setInterval(function () {
    if (styleView() || ++sv > 30) clearInterval(svIv);
  }, 1000);
  window.addEventListener('location-changed', function () {
    closeGroupPopup();
    setTimeout(styleView, 2000);
  });
})();
