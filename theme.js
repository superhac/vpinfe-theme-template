/*
Template theme demonstrating all VPinFE theme patterns.
See theme.md for full documentation.
*/

// Globals
windowName = ""
currentTableIndex = 0;

// Audio manager for table audio with crossfade.
// Works on both backends:
//   Chromium: direct audio.play() via --autoplay-policy flag
//   pywebview: falls back to trigger_audio_play via Python's evaluate_js
const tableAudio = {
    audio: Object.assign(new Audio(), { loop: true }),
    fadeId: null,
    fadeDuration: 500,
    maxVolume: 0.8,
    currentUrl: null,

    play(url, retries = 3) {
        if (!url) { this.stop(); return; }
        if (this.currentUrl === url && !this.audio.paused) return;

        const audio = this.audio;
        clearInterval(this.fadeId);
        audio.pause();
        audio.volume = 0;
        audio.src = url;
        this.currentUrl = url;

        audio.play().then(() => {
            if (this.currentUrl === url) this._fade(0, this.maxVolume);
        }).catch(e => {
            if (e.name === 'NotAllowedError') {
                // Autoplay blocked (pywebview/WebKitGTK) - fall back to Python bridge
                this._retries = retries;
                this._triggerWhenReady(url);
            } else {
                if (retries > 0 && this.currentUrl === url) {
                    setTimeout(() => this.play(url, retries - 1), 1000);
                }
            }
        });
    },

    _triggerWhenReady(url) {
        if (this.currentUrl !== url) return;
        if (this.audio.readyState >= 2) {
            vpin.call("trigger_audio_play").catch(() => {});
        } else {
            this.audio.addEventListener('canplay', () => {
                if (this.currentUrl === url) {
                    vpin.call("trigger_audio_play").catch(() => {});
                }
            }, { once: true });
        }
    },

    // Called from Python via evaluate_js (pywebview privileged context)
    _resumePlay() {
        const url = this.currentUrl;
        const retries = this._retries || 0;
        if (!url) return;
        this.audio.play().then(() => {
            if (this.currentUrl === url) this._fade(0, this.maxVolume);
        }).catch(e => {
            if (retries > 0 && this.currentUrl === url) {
                this._retries = retries - 1;
                setTimeout(() => this._triggerWhenReady(url), 500);
            }
        });
    },

    stop() {
        if (this.audio && !this.audio.paused) {
            this._fade(this.audio.volume, 0, () => {
                this.audio.pause();
                this.currentUrl = null;
            });
        } else {
            clearInterval(this.fadeId);
            this.currentUrl = null;
        }
    },

    _fade(from, to, onComplete) {
        clearInterval(this.fadeId);
        const audio = this.audio;
        if (!audio) { if (onComplete) onComplete(); return; }
        audio.volume = from;
        const steps = this.fadeDuration / 20;
        const delta = (to - from) / steps;
        this.fadeId = setInterval(() => {
            const next = audio.volume + delta;
            if ((delta > 0 && next >= to) || (delta < 0 && next <= to) || delta === 0) {
                audio.volume = to;
                clearInterval(this.fadeId);
                if (onComplete) onComplete();
            } else {
                audio.volume = next;
            }
        }, 20);
    }
};

// init the core interface to VPinFE
const vpin = new VPinFECore();
vpin.init();
window.vpin = vpin // main menu needs this to call back in.

// Register receiveEvent globally BEFORE vpin.ready to avoid timing issues
window.receiveEvent = receiveEvent;

// wait for VPinFECore to be ready
vpin.ready.then(async () => {
    console.log("VPinFECore is fully initialized");

    await vpin.call("get_my_window_name")
        .then(result => {
            windowName = result;
        });

    // Register your input handler. VPinFECore handles all input (keyboard or gamepad)
    // and calls your handler when input is detected.
    vpin.registerInputHandler(handleInput);

    // Optional: load a config.json from your theme dir for user-customizable options
    config = await vpin.call("get_theme_config");

    // Initialize the display
    updateScreen();
});

// Listener for window events. VPinFECore uses this to send events to all windows.
async function receiveEvent(message) {
    vpin.call("console_out", message); // debug: send to Python CLI console

    // Let VPinFECore handle the data refresh logic (TableDataChange, filters, sorts)
    await vpin.handleEvent(message);

    // Handle UI updates based on event type
    if (message.type == "TableIndexUpdate") {
        currentTableIndex = message.index;
        updateScreen();
    }
    else if (message.type == "TableLaunching") {
        tableAudio.stop();
        fadeOut();
    }
    else if (message.type == "TableLaunchComplete") {
        fadeIn();
        if (windowName === "table") tableAudio.play(vpin.getAudioURL(currentTableIndex));
    }
    else if (message.type == "RemoteLaunching") {
        // Remote launch from manager UI
        tableAudio.stop();
        showRemoteLaunchOverlay(message.table_name);
        fadeOut();
    }
    else if (message.type == "RemoteLaunchComplete") {
        // Remote launch completed
        hideRemoteLaunchOverlay();
        fadeIn();
        if (windowName === "table") tableAudio.play(vpin.getAudioURL(currentTableIndex));
    }
    else if (message.type == "TableDataChange") {
        currentTableIndex = message.index;
        updateScreen();
    }
}

// Input handler function. ***** Only for the "table" window *****
// These actions are passed to your handler:
//   joyleft, joyright, joyup, joydown, joyselect, joyback
// These actions are handled internally by VPinFECore (NOT passed to your handler):
//   joymenu, joycollectionmenu, joyexit
async function handleInput(input) {
    switch (input) {
        case "joyleft":
            currentTableIndex = wrapIndex(currentTableIndex - 1, vpin.tableData.length);
            updateScreen();

            // tell other windows the table index changed
            vpin.sendMessageToAllWindows({
                type: 'TableIndexUpdate',
                index: currentTableIndex
            });
            break;
        case "joyright":
            currentTableIndex = wrapIndex(currentTableIndex + 1, vpin.tableData.length);
            updateScreen();

            // tell other windows the table index changed
            vpin.sendMessageToAllWindows({
                type: 'TableIndexUpdate',
                index: currentTableIndex
            });
            break;
        case "joyselect":
            tableAudio.stop();
            vpin.sendMessageToAllWindows({ type: "TableLaunching" });
            await fadeOut();
            await vpin.launchTable(currentTableIndex);
            break;
        case "joyback":
            // do something on joyback if you want
            break;
    }
}

// Main update function - called when table index changes or data refreshes.
// All three windows (table, bg, dmd) load the same theme.js, so use windowName
// to branch logic per window.
function updateScreen() {
    if (windowName === "table") {
        updateTableWindow();
        tableAudio.play(vpin.getAudioURL(currentTableIndex));
    } else if (windowName === "bg") {
        updateBGWindow();
    } else if (windowName === "dmd") {
        updateDMDWindow();
    }
}

// ---- Table Window (main screen) ----
function updateTableWindow() {
    const container = document.getElementById('rootContainer');
    container.innerHTML = '';

    if (!vpin.tableData || vpin.tableData.length === 0) {
        container.innerHTML = '<div style="color: white; font-size: 2em; text-align: center; margin-top: 20%;">No tables found</div>';
        return;
    }

    // -- Table Info --
    // vpin.getTableMeta() returns the full table data object.
    // meta.Info has VPSdb data, meta.VPXFile has data from the .vpx file itself.
    const table = vpin.getTableMeta(currentTableIndex);
    const info = table.meta.Info || {};
    const vpx = table.meta.VPXFile || {};

    // Title: prefer Info.Title, fallback to VPX filename, then directory name
    const title = info.Title || vpx.filename || table.tableDirName || 'Unknown Table';
    const manufacturer = info.Manufacturer || vpx.manufacturer || 'Unknown';
    const year = info.Year || vpx.year || '';
    const authors = Array.isArray(info.Authors) ? info.Authors.join(', ') : 'Unknown';
    const tableType = info.Type || vpx.type || '';

    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'padding: 20px; font-family: sans-serif;';
    infoDiv.innerHTML = `
        <h1 style="margin: 0 0 10px 0;">${title}</h1>
        <div style="color: #aaa; font-size: 1.2em; margin-bottom: 5px;">
            ${manufacturer}${year ? ' &bull; ' + year : ''}${tableType ? ' &bull; ' + tableType : ''}
        </div>
        <div style="color: #888; font-size: 1em; margin-bottom: 15px;">Authors: ${authors}</div>
        <div style="color: #666; font-size: 0.9em;">Table ${currentTableIndex + 1} of ${vpin.getTableCount()}</div>
    `;
    container.appendChild(infoDiv);

    // -- Wheel Image --
    const wheelImg = document.createElement('img');
    wheelImg.src = vpin.getImageURL(currentTableIndex, "wheel");
    wheelImg.style.cssText = 'max-height: 15vh; margin: 10px 20px;';
    wheelImg.onerror = () => { wheelImg.style.display = 'none'; };
    container.appendChild(wheelImg);

    // -- Video with Image Fallback --
    // Check if video exists by looking at the raw path property
    const videoUrl = vpin.getVideoURL(currentTableIndex, 'table');
    const imageUrl = vpin.getImageURL(currentTableIndex, 'table');
    const mediaDiv = document.createElement('div');
    mediaDiv.style.cssText = 'margin: 10px 20px;';

    if (videoUrl && !videoUrl.includes('file_missing')) {
        const video = document.createElement('video');
        video.src = videoUrl;
        video.poster = imageUrl; // stable dimensions while video loads
        video.autoplay = true;
        video.loop = true;
        video.muted = true;     // required for autoplay
        video.playsInline = true;
        video.style.cssText = 'max-height: 30vh; border-radius: 8px;';
        // Fall back to image if video fails to load
        video.onerror = () => {
            const fallback = document.createElement('img');
            fallback.src = imageUrl;
            fallback.style.cssText = 'max-height: 30vh; border-radius: 8px;';
            video.replaceWith(fallback);
        };
        mediaDiv.appendChild(video);
    } else {
        const img = document.createElement('img');
        img.src = imageUrl;
        img.style.cssText = 'max-height: 30vh; border-radius: 8px;';
        mediaDiv.appendChild(img);
    }
    container.appendChild(mediaDiv);

    // -- Feature Detection Flags --
    // VPX detection flags indicate what addons/features are detected in the table
    const featDiv = document.createElement('div');
    featDiv.style.cssText = 'margin: 10px 20px; display: flex; flex-wrap: wrap; gap: 8px;';

    const features = [
        { key: "detectnfozzy", label: "Nfozzy" },
        { key: "detectfleep", label: "Fleep" },
        { key: "detectssf", label: "SSF" },
        { key: "detectfastflips", label: "FastFlips" },
        { key: "detectlut", label: "LUT" },
        { key: "detectscorebit", label: "ScoreBit" },
        { key: "detectflex", label: "FlexDMD" },
        { key: "altSoundExists", label: "AltSound" },
        { key: "altColorExists", label: "AltColor" },
        { key: "pupPackExists", label: "PuP-Pack" },
    ];

    features.forEach(({ key, label }) => {
        const isOn = vpx[key] === true || vpx[key] === "true" || vpx[key] === 1;
        const badge = document.createElement('span');
        badge.textContent = label;
        badge.style.cssText = `
            padding: 4px 10px; border-radius: 12px; font-size: 0.8em; font-weight: bold;
            color: ${isOn ? '#000' : '#aaa'};
            background: ${isOn ? '#4CAF50' : '#333'};
        `;
        featDiv.appendChild(badge);
    });
    container.appendChild(featDiv);

    // -- Media URLs (debug info) --
    const urlsDiv = document.createElement('div');
    urlsDiv.style.cssText = 'margin: 10px 20px; color: #555; font-size: 0.75em; font-family: monospace;';
    urlsDiv.innerHTML = `
        <div>table img: ${vpin.getImageURL(currentTableIndex, "table")}</div>
        <div>bg img: ${vpin.getImageURL(currentTableIndex, "bg")}</div>
        <div>dmd img: ${vpin.getImageURL(currentTableIndex, "dmd")}</div>
        <div>wheel img: ${vpin.getImageURL(currentTableIndex, "wheel")}</div>
        <div>cab img: ${vpin.getImageURL(currentTableIndex, "cab")}</div>
        <div>table video: ${vpin.getVideoURL(currentTableIndex, "table")}</div>
        <div>bg video: ${vpin.getVideoURL(currentTableIndex, "bg")}</div>
        <div>dmd video: ${vpin.getVideoURL(currentTableIndex, "dmd")}</div>
        <div>audio: ${vpin.getAudioURL(currentTableIndex) || 'null (no audio file)'}</div>
    `;
    container.appendChild(urlsDiv);

    // -- Raw Metadata JSON (debug info) --
    const metaDiv = document.createElement('details');
    metaDiv.style.cssText = 'margin: 10px 20px; color: #555; font-size: 0.75em;';
    metaDiv.innerHTML = `
        <summary style="cursor: pointer;">Raw table metadata (JSON)</summary>
        <pre style="max-height: 40vh; overflow: auto;">${JSON.stringify(table, null, 2)}</pre>
    `;
    container.appendChild(metaDiv);
}

// ---- BG Window (backglass) ----
function updateBGWindow() {
    const container = document.getElementById('rootContainer');
    if (!vpin.tableData || vpin.tableData.length === 0) {
        container.innerHTML = '';
        return;
    }

    const bgUrl = vpin.getImageURL(currentTableIndex, "bg");
    let img = container.querySelector('img');
    if (!img) {
        img = document.createElement('img');
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
        container.appendChild(img);
    }
    img.src = bgUrl;
}

// ---- DMD Window ----
function updateDMDWindow() {
    const container = document.getElementById('rootContainer');
    if (!vpin.tableData || vpin.tableData.length === 0) {
        container.innerHTML = '';
        return;
    }

    const dmdUrl = vpin.getImageURL(currentTableIndex, "dmd");
    let img = container.querySelector('img');
    if (!img) {
        img = document.createElement('img');
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
        container.appendChild(img);
    }
    img.src = dmdUrl;
}

//
// Support functions
//

// circular table index
function wrapIndex(index, length) {
    return (index + length) % length;
}

// Fade transition using the fadeOverlay pattern
function fadeOut() {
    const overlay = document.getElementById("fadeOverlay");
    if (overlay) overlay.classList.add("show");
}

function fadeIn() {
    const overlay = document.getElementById("fadeOverlay");
    if (overlay) overlay.classList.remove("show");
}

// Remote launch overlay functions
function showRemoteLaunchOverlay(tableName) {
    const overlay = document.getElementById('remote-launch-overlay');
    const nameEl = document.getElementById('remote-launch-table-name');
    if (overlay && nameEl) {
        nameEl.textContent = tableName || 'Unknown Table';
        overlay.style.display = 'flex';
    }
}

function hideRemoteLaunchOverlay() {
    const overlay = document.getElementById('remote-launch-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}
