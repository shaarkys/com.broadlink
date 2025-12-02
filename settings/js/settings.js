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

function api(Homey, method, path, body) {
  return new Promise((resolve, reject) => {
    Homey.api(method, path, body, (err, result) => {
      if (err) return reject(err);
      if (result && result.error) return reject(new Error(result.error));
      resolve(result);
    });
  });
}

function setUsageText(text) {
  const usageEl = document.getElementById("rf-usage");
  if (usageEl) usageEl.textContent = text || "";
}

function renderDeviceSelect() {
  const select = document.getElementById("rf-device-select");
  if (!select) return;
  select.innerHTML = '<option value="">Select a Broadlink RM device</option>';
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
    saveBtn.addEventListener("click", () => onRenameCommand(name, input.value.trim()));

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "delete";
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
    const result = await api(Homey, "GET", "/rf/devices");
    rfState.devices = result.devices || [];
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
    Homey.alert("Failed to load RF devices. Is the app updated to the latest version?", "error");
  }
}

async function loadCommands(Homey) {
  if (!rfState.selectedMac) {
    renderCommands();
    return;
  }
  try {
    const result = await api(Homey, "GET", `/rf/devices/${rfState.selectedMac}/commands`);
    rfState.commands = result.commands || [];
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
    await api(Homey, "POST", `/rf/devices/${rfState.selectedMac}/commands/rename`, { oldName, newName });
    rfState.commands = rfState.commands.map((c) => (c === oldName ? newName : c));
    renderCommands();
    Homey.alert(`Renamed to ${newName}`, "info");
  } catch (err) {
    console.error(err);
    Homey.alert(err && err.message ? err.message : "Rename failed", "error");
  }
}

async function onDeleteCommand(cmdName) {
  if (!confirm(`Delete command "${cmdName}"?`)) return;
  try {
    await api(Homey, "DELETE", `/rf/devices/${rfState.selectedMac}/commands/${encodeURIComponent(cmdName)}`);
    rfState.commands = rfState.commands.filter((c) => c !== cmdName);
    setUsageText(`${rfState.commands.length} command(s) stored`);
    renderCommands();
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
