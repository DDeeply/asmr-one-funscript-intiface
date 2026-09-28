// ==UserScript==
// @name         ASMR.one (Kikoeru) RJ嗅探 + Funscript同步播放器 (Intiface驱动)
// @namespace    https://github.com/ykcjack/asmr-one-intiface
// @version      5.8.0
// @description  在 ASMR.one 网页端自动嗅探当前 RJ 编号并联动 EroScripts，支持拖入 .funscript 脚本高频同步控制外设，支持役次元活塞（Oscillate）与多轴设备，提供 0%~200% 灵敏度微调悬浮窗。
// @author       ykcjack
// @match        https://www.asmr.one/*
// @match        https://asmr.one/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    console.log("[ASMR-Funscript] v5.8 灵敏度 0%~200% 版加载...");

    const INTIFACE_WS_URL = "ws://127.0.0.1:12345";
    let ws = null;
    let targetDeviceIndex = -1;
    let targetDeviceName = "未连接";
    let targetActuators = [];
    let msgId = 1;

    let currentRJ = "未检测到";
    let funscriptActions = null;
    let lastSeekIndex = 0;
    let isMinimized = false;

    // 灵敏度倍率 (0.0 ~ 2.0，默认 1.0 即 100%)
    let sensitivity = parseFloat(localStorage.getItem("af_sensitivity") || "1.0");

    // --- 创建可拖动悬浮窗 ---
    const ui = document.createElement("div");
    ui.id = "asmr-funscript-panel";
    ui.style.position = "fixed";
    ui.style.zIndex = "9999999";
    ui.style.background = "rgba(18, 18, 26, 0.96)";
    ui.style.color = "#fff";
    ui.style.padding = "12px 16px";
    ui.style.borderRadius = "12px";
    ui.style.fontSize = "12px";
    ui.style.fontFamily = "sans-serif";
    ui.style.boxShadow = "0 6px 22px rgba(0,0,0,0.65)";
    ui.style.border = "1px solid #7c4dff";
    ui.style.minWidth = "260px";
    ui.style.userSelect = "none";

    const savedLeft = localStorage.getItem("af_pos_left");
    const savedTop = localStorage.getItem("af_pos_top");
    if (savedLeft && savedTop) {
        ui.style.left = savedLeft;
        ui.style.top = savedTop;
    } else {
        ui.style.top = "80px";
        ui.style.right = "20px";
    }

    ui.innerHTML = `
        <div id="af-drag-header" style="cursor: move; font-weight: bold; margin-bottom: 6px; color: #b388ff; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">
            <span>🎮 ASMR 脚本同步器 (按住拖动)</span>
            <span id="af-min-btn" style="cursor: pointer; padding: 0 5px; color: #aaa; font-size: 14px;" title="折叠">−</span>
        </div>

        <div id="af-body-content">
            <div style="margin-bottom: 3px; display: flex; justify-content: space-between;">
                <span>Intiface通信:</span>
                <b id="af-ws-status" style="color: red;">未连接</b>
            </div>
            <div style="margin-bottom: 3px;">当前作品: <b id="af-rj-text" style="color: #ffd700;">检测中...</b> <a id="af-rj-link" href="#" target="_blank" style="display:none; color: #00e5ff; text-decoration: underline; margin-left: 4px;">[搜脚本]</a></div>
            <div style="margin-bottom: 3px;">物理玩具: <b id="af-device-name" style="color: #64b5f6;">-</b></div>
            <div style="margin-bottom: 3px;">音频捕获: <b id="af-audio-status" style="color: #ff9800;">未播放</b></div>
            <div style="margin-bottom: 3px;">脚本状态: <b id="af-script-status" style="color: #ff5252;">请导入 .funscript</b></div>
            <div style="margin-bottom: 6px;">活塞输出: <b id="af-pos-text" style="color: #4cd964;">0% (停止)</b></div>

            <!-- 灵敏度 0% ~ 200% 控制器 -->
            <div style="background: rgba(255,255,255,0.05); padding: 6px 8px; border-radius: 6px; margin-bottom: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <span>抽动灵敏度:</span>
                    <b id="af-sens-text" style="color: #ffd700;">${Math.round(sensitivity * 100)}%</b>
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <button id="af-btn-sens-dec" style="background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; width: 22px; height: 20px; cursor: pointer;">-</button>
                    <input type="range" id="af-sens-range" min="0" max="200" value="${Math.round(sensitivity * 100)}" style="flex: 1; cursor: pointer; height: 4px; accent-color: #7c4dff;">
                    <button id="af-btn-sens-inc" style="background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; width: 22px; height: 20px; cursor: pointer;">+</button>
                    <button id="af-btn-sens-reset" style="background: #333; color: #aaa; border: 1px solid #555; border-radius: 3px; padding: 0 4px; height: 20px; cursor: pointer; font-size: 10px;">重置</button>
                </div>
            </div>

            <!-- 拖放区域 -->
            <div id="af-drop-zone" style="border: 2px dashed #7c4dff; border-radius: 8px; padding: 8px; text-align: center; background: rgba(124, 77, 255, 0.1); cursor: pointer;">
                <span style="color: #cfd8dc; font-size: 11px;">📂 拖拽 .funscript 到此<br>或点击选择文件</span>
                <input type="file" id="af-file-input" accept=".funscript,.json" style="display: none;">
            </div>

            <!-- 测试按钮 -->
            <button id="af-btn-test" style="width: 100%; margin-top: 6px; background: #333; color: #00e5ff; border: 1px solid #555; padding: 4px; border-radius: 4px; cursor: pointer; font-size: 11px;">🧪 活塞测试 (点一下试动)</button>
        </div>

        <div id="af-mini-content" style="display: none; cursor: pointer; align-items: center; justify-content: space-between;">
            <span style="color: #b388ff; font-size: 11px;">🎮 <b id="af-mini-pos" style="color:#4cd964;">0%</b></span>
            <span style="color: #00e5ff; font-size: 10px; margin-left: 10px;">展开 ＋</span>
        </div>
    `;
    document.body.appendChild(ui);

    // --- 0% ~ 200% 灵敏度逻辑 ---
    const sensRange = document.getElementById("af-sens-range");
    const sensText = document.getElementById("af-sens-text");

    function setSensitivity(val) {
        sensitivity = Math.max(0.0, Math.min(2.0, val));
        sensText.innerText = `${Math.round(sensitivity * 100)}%`;
        sensRange.value = Math.round(sensitivity * 100);
        localStorage.setItem("af_sensitivity", sensitivity.toFixed(2));
    }

    sensRange.oninput = (e) => setSensitivity(parseInt(e.target.value, 10) / 100.0);
    document.getElementById("af-btn-sens-dec").onclick = () => setSensitivity(sensitivity - 0.1);
    document.getElementById("af-btn-sens-inc").onclick = () => setSensitivity(sensitivity + 0.1);
    document.getElementById("af-btn-sens-reset").onclick = () => setSensitivity(1.0);

    // --- 拖动与折叠 ---
    const dragHeader = document.getElementById("af-drag-header");
    let isDragging = false, startX, startY, initLeft, initTop;
    dragHeader.onmousedown = (e) => {
        isDragging = true; startX = e.clientX; startY = e.clientY;
        const rect = ui.getBoundingClientRect();
        initLeft = rect.left; initTop = rect.top;
        ui.style.right = "auto"; ui.style.bottom = "auto";
        ui.style.left = initLeft + "px"; ui.style.top = initTop + "px";
        e.preventDefault();
    };
    document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        ui.style.left = Math.max(10, Math.min(window.innerWidth - ui.offsetWidth - 10, initLeft + e.clientX - startX)) + "px";
        ui.style.top = Math.max(10, Math.min(window.innerHeight - ui.offsetHeight - 10, initTop + e.clientY - startY)) + "px";
    });
    document.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            localStorage.setItem("af_pos_left", ui.style.left);
            localStorage.setItem("af_pos_top", ui.style.top);
        }
    });

    const bodyContent = document.getElementById("af-body-content");
    const miniContent = document.getElementById("af-mini-content");
    function toggleMin() {
        isMinimized = !isMinimized;
        bodyContent.style.display = isMinimized ? "none" : "block";
        dragHeader.style.display = isMinimized ? "none" : "flex";
        miniContent.style.display = isMinimized ? "flex" : "none";
        ui.style.minWidth = isMinimized ? "auto" : "260px";
        ui.style.padding = isMinimized ? "6px 12px" : "12px 16px";
    }
    document.getElementById("af-min-btn").onclick = toggleMin;
    miniContent.onclick = toggleMin;

    // --- 连接 Intiface Central ---
    function connectIntiface() {
        try {
            ws = new WebSocket(INTIFACE_WS_URL);
            ws.onopen = () => {
                document.getElementById("af-ws-status").innerHTML = '<span style="color: #4cd964;">已连接</span>';
                ws.send(JSON.stringify([{ "RequestServerInfo": { "Id": msgId++, "ClientName": "ASMRFunscript", "MessageVersion": 3 } }]));
            };
            ws.onmessage = (e) => {
                try {
                    const msgs = JSON.parse(e.data);
                    for (const msg of msgs) {
                        if (msg.ServerInfo) ws.send(JSON.stringify([{ "RequestDeviceList": { "Id": msgId++ } }]));
                        else if (msg.DeviceList && msg.DeviceList.Devices.length > 0) inspectDevice(msg.DeviceList.Devices[0]);
                        else if (msg.DeviceAdded) inspectDevice(msg.DeviceAdded);
                    }
                } catch(err) {}
            };
            ws.onclose = () => {
                document.getElementById("af-ws-status").innerHTML = '<span style="color: red;">已断开</span>';
                setTimeout(connectIntiface, 3000);
            };
        } catch(e) { setTimeout(connectIntiface, 3000); }
    }
    connectIntiface();

    function inspectDevice(device) {
        targetDeviceIndex = device.DeviceIndex;
        targetDeviceName = device.DeviceName;
        targetActuators = [];
        if (device.DeviceMessages && device.DeviceMessages.ScalarCmd) {
            for (let i = 0; i < device.DeviceMessages.ScalarCmd.length; i++) {
                const feat = device.DeviceMessages.ScalarCmd[i];
                targetActuators.push({ Index: feat.FeatureIndex !== undefined ? feat.FeatureIndex : i, ActuatorType: feat.ActuatorType || "Oscillate" });
            }
        }
        if (targetActuators.length === 0) targetActuators.push({ Index: 0, ActuatorType: "Oscillate" });
        document.getElementById("af-device-name").innerText = targetDeviceName;
    }

    function sendStroke(scalar, label) {
        if (!ws || ws.readyState !== WebSocket.OPEN || targetDeviceIndex === -1) return;
        document.getElementById("af-pos-text").innerText = label;
        document.getElementById("af-mini-pos").innerText = label;

        const scalars = targetActuators.map(act => ({ Index: act.Index, Scalar: scalar, ActuatorType: act.ActuatorType }));
        ws.send(JSON.stringify([{ "ScalarCmd": { "Id": msgId++, "DeviceIndex": targetDeviceIndex, "Scalars": scalars } }]));
    }

    document.getElementById("af-btn-test").onclick = () => {
        sendStroke(0.6, "测试运行 (60%)");
        setTimeout(() => sendStroke(0.0, "停止 (0%)"), 2000);
    };

    function getActiveAudio() {
        const audios = Array.from(document.querySelectorAll("audio, video"));
        return audios.find(a => !a.paused && a.currentTime > 0) || audios.find(a => !a.paused) || audios[0] || null;
    }

    function sniffRJ() {
        const textToSearch = document.title + " " + window.location.href + " " + (document.querySelector(".work-title")?.innerText || "");
        const match = textToSearch.match(/(RJ\d{6,8}|VJ\d{6,8})/i);
        if (match && match[1].toUpperCase() !== currentRJ) {
            currentRJ = match[1].toUpperCase();
            document.getElementById("af-rj-text").innerText = currentRJ;
            const link = document.getElementById("af-rj-link");
            link.href = `https://discuss.eroscripts.com/search?q=${currentRJ}`;
            link.style.display = "inline";
        }
    }
    setInterval(sniffRJ, 1500);

    function loadFunscript(text) {
        try {
            const data = JSON.parse(text);
            if (data.actions && Array.isArray(data.actions) && data.actions.length > 0) {
                funscriptActions = data.actions.sort((a, b) => a.at - b.at);
                lastSeekIndex = 0;
                document.getElementById("af-script-status").innerHTML = `<span style="color:#4cd964;">已载入 (${funscriptActions.length} 动作点)</span>`;
            } else { alert("文件中未找到 actions 动作点！"); }
        } catch(e) { alert("脚本解析失败: " + e.message); }
    }

    const dropZone = document.getElementById("af-drop-zone");
    const fileInput = document.getElementById("af-file-input");
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => loadFunscript(ev.target.result);
            reader.readAsText(file);
        }
    };
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.background = "rgba(124, 77, 255, 0.3)"; };
    dropZone.ondragleave = () => { dropZone.style.background = "rgba(124, 77, 255, 0.1)"; };
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.style.background = "rgba(124, 77, 255, 0.1)";
        const file = e.dataTransfer.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => loadFunscript(ev.target.result);
            reader.readAsText(file);
        }
    };

    // --- 核心同步高频时钟 ---
    setInterval(() => {
        const audio = getActiveAudio();
        const audioStatusEl = document.getElementById("af-audio-status");
        if (!audioStatusEl) return;

        if (!audio) {
            audioStatusEl.innerHTML = '<span style="color: #ff9800;">未播放</span>';
            return;
        }

        const sec = Math.floor(audio.currentTime);
        const timeStr = `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;

        if (audio.paused) {
            audioStatusEl.innerHTML = `<span style="color: #ff9800;">已暂停 (${timeStr})</span>`;
            sendStroke(0.0, "音频暂停");
            return;
        }

        audioStatusEl.innerHTML = `<span style="color: #4cd964;">播放中 (${timeStr})</span>`;
        const currentMs = audio.currentTime * 1000;

        if (!funscriptActions || funscriptActions.length < 2) {
            document.getElementById("af-pos-text").innerText = "等待导入脚本";
            return;
        }

        // 如果灵敏度拉到了 0%，强制静止
        if (sensitivity === 0) {
            sendStroke(0.0, "灵敏度 0% (静止)");
            return;
        }

        let idx = lastSeekIndex;
        if (idx >= funscriptActions.length || funscriptActions[idx].at > currentMs) idx = 0;
        while (idx < funscriptActions.length - 1 && funscriptActions[idx + 1].at < currentMs) {
            idx++;
        }
        lastSeekIndex = idx;

        const prev = funscriptActions[idx];
        const next = funscriptActions[idx + 1];

        if (prev && next) {
            if (currentMs < prev.at) {
                sendStroke(0.0, `等待起抽 (首点: ${Math.round(prev.at/1000)}秒)`);
                return;
            }

            const duration = next.at - prev.at;
            if (duration > 0 && currentMs <= next.at) {
                const progress = (currentMs - prev.at) / duration;
                const currentPos = prev.pos + (next.pos - prev.pos) * progress;

                const distance = Math.abs(next.pos - prev.pos);
                const speed = (distance / duration) * 1000;

                // 灵敏度倍率计算 (0% ~ 200%)
                let baseScalar = speed / 180.0;
                let scalar = Math.min(Math.max(baseScalar * sensitivity, 0.0), 1.0);
                if (distance === 0) scalar = 0.0;

                sendStroke(scalar, `速度 ${Math.round(scalar * 100)}% | 深度 ${Math.round(currentPos)}%`);
            } else {
                sendStroke(0.0, "待机段");
            }
        }
    }, 50);
})();