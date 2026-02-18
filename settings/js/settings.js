function saveDebugSettings(Homey) {
  var compatmode = document.getElementById("compatmode") ? document.getElementById("compatmode").checked : false;
  var debuglog = document.getElementById("debuglog") ? document.getElementById("debuglog").checked : false;
  var currentSettings = {
    compat: compatmode,
    logging: debuglog,
  };
  Homey.set("DebugSettings", currentSettings);
}

const rfState = {
  devices: [],
  selectedMac: "",
  commands: [],
};

function settingsGet(Homey, key) {
  return new Promise((resolve, reject) => {
    Homey.get(key, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function settingsSet(Homey, key, value) {
  return new Promise((resolve, reject) => {
    Homey.set(key, value, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function askDeleteConfirmation(Homey, cmdName) {
  const message = `Delete command "${cmdName}"?`;
  if (Homey && typeof Homey.confirm === "function") {
    return new Promise((resolve) => {
      Homey.confirm(message, "warning", (err, confirmed) => {
        if (err) {
          console.error(err);
          resolve(false);
          return;
        }
        resolve(Boolean(confirmed));
      });
    });
  }
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return Promise.resolve(window.confirm(message));
  }
  return Promise.resolve(true);
}

async function waitForResult(Homey, requestId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await settingsGet(Homey, "rfManagerResult");
    if (result && result.requestId === requestId) {
      if (result.ok) return result;
      throw new Error(result.error || "RF manager action failed");
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for RF manager");
}

async function callAction(Homey, action) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await settingsSet(Homey, "rfManagerAction", Object.assign({}, action, { requestId }));
  return waitForResult(Homey, requestId, 4000);
}

function setUsageText(text) {
  const usageEl = document.getElementById("rf-usage");
  if (usageEl) usageEl.textContent = text || "";
}

function renderDeviceSelect() {
  const select = document.getElementById("rf-device-select");
  if (!select) return;
  select.innerHTML = "";
  rfState.devices.forEach((device) => {
    const option = document.createElement("option");
    option.value = device.mac;
    option.textContent = `${device.name} (${device.driverId || "RM"})`;
    select.appendChild(option);
  });
  if (rfState.selectedMac) {
    select.value = rfState.selectedMac;
  }
}

function renderCommands() {
  const list = document.getElementById("rf-command-list");
  if (!list) return;
  list.innerHTML = "";

  if (!rfState.selectedMac) {
    list.innerHTML = '<div class="rf-empty">Select a device to view RF commands.</div>';
    setUsageText("");
    return;
  }

  if (!rfState.commands.length) {
    list.innerHTML = '<div class="rf-empty">No RF commands stored yet. Learn a command on the device, then refresh.</div>';
    return;
  }

  rfState.commands.forEach((name) => {
    const row = document.createElement("div");
    row.className = "rf-row";

    const input = document.createElement("input");
    input.type = "text";
    input.value = name;
    input.dataset.original = name;

    const actions = document.createElement("div");
    actions.className = "actions";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Rename";
    saveBtn.className = "primary";
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => onRenameCommand(name, input.value.trim()));

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => onDeleteCommand(name));

    input.addEventListener("keyup", (ev) => {
      if (ev.key === "Enter") {
        onRenameCommand(name, input.value.trim());
      }
    });

    actions.appendChild(saveBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(input);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function loadDevices(Homey) {
  try {
    await callAction(Homey, { type: "refreshDevices" });
    const devices = await settingsGet(Homey, "rfDevices");
    rfState.devices = Array.isArray(devices) ? devices : [];
    const previousSelection = rfState.selectedMac;
    if (!previousSelection || !rfState.devices.find((d) => d.mac === previousSelection)) {
      rfState.selectedMac = rfState.devices[0]?.mac || "";
    }
    if (!rfState.devices.length) {
      setUsageText("No RF devices registered yet.");
    }
    renderDeviceSelect();
    if (rfState.selectedMac) {
      await loadCommands(Homey);
    } else {
      renderCommands();
    }
  } catch (err) {
    console.error(err);
    Homey.alert(err && err.message ? err.message : "Failed to load RF devices.", "error");
  }
}

async function loadCommands(Homey) {
  if (!rfState.selectedMac) {
    renderCommands();
    return;
  }
  try {
    await callAction(Homey, { type: "refreshCommands", mac: rfState.selectedMac });
    const commands = await settingsGet(Homey, `rfCommands_${rfState.selectedMac}`);
    rfState.commands = Array.isArray(commands) ? commands : [];
    setUsageText(`${rfState.commands.length} command(s) stored`);
    renderCommands();
  } catch (err) {
    console.error(err);
    Homey.alert("Failed to load commands for this device.", "error");
  }
}

async function onRenameCommand(oldName, newName) {
  if (!newName || newName === oldName) {
    return;
  }
  try {
    await callAction(Homey, { type: "renameCommand", mac: rfState.selectedMac, oldName, newName });
    await loadCommands(Homey);
    Homey.alert(`Renamed to ${newName}`, "info");
  } catch (err) {
    console.error(err);
    Homey.alert(err && err.message ? err.message : "Rename failed", "error");
  }
}

async function onDeleteCommand(cmdName) {
  const confirmed = await askDeleteConfirmation(Homey, cmdName);
  if (!confirmed) return;
  try {
    await callAction(Homey, { type: "deleteCommand", mac: rfState.selectedMac, cmdName });
    await loadCommands(Homey);
  } catch (err) {
    console.error(err);
    Homey.alert("Delete failed", "error");
  }
}

function wireRfEvents(Homey) {
  const select = document.getElementById("rf-device-select");
  const refreshDevicesBtn = document.getElementById("rf-refresh-devices");
  const refreshCommandsBtn = document.getElementById("rf-refresh-commands");

  if (select) {
    select.addEventListener("change", (ev) => {
      rfState.selectedMac = ev.target.value;
      loadCommands(Homey);
    });
  }
  if (refreshDevicesBtn) {
    refreshDevicesBtn.addEventListener("click", () => {
      loadDevices(Homey);
    });
  }
  if (refreshCommandsBtn) {
    refreshCommandsBtn.addEventListener("click", () => loadCommands(Homey));
  }
}

function bindDebugSettings(Homey) {
  var compatmodeElement = document.getElementById("compatmode");
  var debuglogElement = document.getElementById("debuglog");

  if (compatmodeElement) {
    compatmodeElement.addEventListener("change", function () {
      saveDebugSettings(Homey);
    });
  }
  if (debuglogElement) {
    debuglogElement.addEventListener("change", function () {
      saveDebugSettings(Homey);
    });
  }
}

function loadDebugSettings(Homey) {
  Homey.get("DebugSettings", function (error, currentSettings) {
    if (error || !currentSettings) {
      if (error) {
        Homey.alert(error, "error", null);
      }
      return;
    }
    var compatmodeElement = document.getElementById("compatmode");
    var debuglogElement = document.getElementById("debuglog");
    if (compatmodeElement) {
      compatmodeElement.checked = currentSettings.compat || false;
    }
    if (debuglogElement) {
      debuglogElement.checked = currentSettings.logging || false;
    }
  });
}

async function onHomeyReady(Homey) {
  bindDebugSettings(Homey);
  loadDebugSettings(Homey);
  wireRfEvents(Homey);
  await loadDevices(Homey);
  Homey.ready();
}
