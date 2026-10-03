// ==UserScript==
// @name         ASMR.one (Kikoeru) 全能音频批量下载器 (一键打包 ZIP 保持目录结构版)
// @namespace    https://github.com/ykcjack/asmr-one-tools
// @version      2.3.1
// @description  完整保持 ASMR.one 原始文件夹层级结构，一键打包下载全部或勾选音频为标准 ZIP 压缩包；内置智能直取官方 CDN 高品质预压缩音频流（0秒转码秒下），支持 fflate 流式极速压缩封口；全新加入硬超时智能跳过与一键“跳过封包”功能，彻底根治最后单文件卡顿假死问题。
// @author       ykcjack
// @match        https://www.asmr.one/*
// @match        https://asmr.one/*
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @require      https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @connect      api.asmr.one
// @connect      asmr.one
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    console.log("[ASMR-Downloader] v2.3.1 一键 ZIP 目录压缩打包版 (防卡死硬超时+跳过封包) 启动...");

    let currentWorkTitle = "ASMR作品";
    let currentRJ = "";
    let rawTreeData = [];
    let flatFileList = [];
    let coverUrl = "";
    let isFetching = false;
    let isZipping = false;
    let abortZipping = false;
    let skipZipping = false;

    // --- 确保 fflate 极速压缩库可用 ---
    function ensureFflate() {
        return new Promise((resolve, reject) => {
            if (typeof fflate !== "undefined" && fflate.Zip) {
                return resolve(window.fflate || fflate);
            }
            const s1 = document.createElement("script");
            s1.src = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js";
            s1.onload = () => resolve(window.fflate || fflate);
            s1.onerror = () => {
                const s2 = document.createElement("script");
                s2.src = "https://cdnjs.cloudflare.com/ajax/libs/fflate/0.8.2/index.js";
                s2.onload = () => resolve(window.fflate || fflate);
                s2.onerror = () => reject(new Error("无法加载 fflate 极速压缩引擎，请检查网络连接！"));
                document.head.appendChild(s2);
            };
            document.head.appendChild(s1);
        });
    }

    // --- 确保 lamejs MP3 编码库可用 ---
    function ensureLamejs() {
        return new Promise((resolve, reject) => {
            if (typeof lamejs !== "undefined" && lamejs.Mp3Encoder) {
                return resolve(window.lamejs || lamejs);
            }
            const s1 = document.createElement("script");
            s1.src = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
            s1.onload = () => resolve(window.lamejs || lamejs);
            s1.onerror = () => {
                const s2 = document.createElement("script");
                s2.src = "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js";
                s2.onload = () => resolve(window.lamejs || lamejs);
                s2.onerror = () => reject(new Error("无法加载 lamejs 编码库，请检查网络连接！"));
                document.head.appendChild(s2);
            };
            document.head.appendChild(s1);
        });
    }

    // --- 极速解析 16-bit PCM WAV（0开销瞬间抽样） ---
    function parseWavPCM(buffer) {
        if (!buffer || buffer.byteLength < 44) return null;
        const view = new DataView(buffer);
        if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
            return null; // 非 RIFF WAVE
        }
        let offset = 12;
        let format = 0, channels = 0, sampleRate = 0, bitsPerSample = 0;
        let dataOffset = 0, dataLength = 0;

        while (offset < buffer.byteLength - 8) {
            const chunkId = view.getUint32(offset, false);
            const chunkSize = view.getUint32(offset + 4, true);
            if (chunkId === 0x666d7420) { // 'fmt '
                format = view.getUint16(offset + 8, true);
                channels = view.getUint16(offset + 10, true);
                sampleRate = view.getUint32(offset + 12, true);
                bitsPerSample = view.getUint16(offset + 22, true);
            } else if (chunkId === 0x64617461) { // 'data'
                dataOffset = offset + 8;
                dataLength = chunkSize;
                break;
            }
            offset += 8 + chunkSize;
        }

        if (format === 1 && bitsPerSample === 16 && dataOffset > 0) {
            const sampleCount = Math.floor(dataLength / (channels * 2));
            const pcmData = new Int16Array(buffer, dataOffset, sampleCount * channels);
            return { channels, sampleRate, sampleCount, pcmData };
        }
        return null;
    }

    // --- 核心：WAV 转 320kbps MP3 (双核自适应：极速原生解析 + WebAudio 回退) ---
    async function convertWavToMp3(arrayBuffer, onProgress) {
        const Lame = await ensureLamejs();

        const parsed = parseWavPCM(arrayBuffer);
        let channels, sampleRate, sampleCount, leftSamples, rightSamples;

        if (parsed) {
            channels = parsed.channels;
            sampleRate = parsed.sampleRate;
            sampleCount = parsed.sampleCount;
            if (channels === 1) {
                leftSamples = parsed.pcmData;
                rightSamples = null;
            } else {
                leftSamples = new Int16Array(sampleCount);
                rightSamples = new Int16Array(sampleCount);
                for (let i = 0; i < sampleCount; i++) {
                    leftSamples[i] = parsed.pcmData[i * 2];
                    rightSamples[i] = parsed.pcmData[i * 2 + 1];
                }
            }
        } else {
            // 回退到 Web Audio API 解码非标准/24-bit WAV
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            let audioBuffer;
            try {
                audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
            } finally {
                if (audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
            }
            channels = Math.min(2, audioBuffer.numberOfChannels);
            sampleRate = audioBuffer.sampleRate;
            sampleCount = audioBuffer.length;
            const lFloat = audioBuffer.getChannelData(0);
            const rFloat = channels > 1 ? audioBuffer.getChannelData(1) : lFloat;

            leftSamples = new Int16Array(sampleCount);
            rightSamples = channels > 1 ? new Int16Array(sampleCount) : null;
            for (let i = 0; i < sampleCount; i++) {
                let s0 = lFloat[i];
                leftSamples[i] = s0 < 0 ? s0 * 0x8000 : s0 * 0x7FFF;
                if (channels > 1) {
                    let s1 = rFloat[i];
                    rightSamples[i] = s1 < 0 ? s1 * 0x8000 : s1 * 0x7FFF;
                }
            }
        }

        // 320kbps 极限高音质 MP3
        const mp3encoder = new Lame.Mp3Encoder(channels, sampleRate, 320);
        const mp3Chunks = [];
        const blockSize = 11520;

        for (let i = 0; i < sampleCount; i += blockSize) {
            if (abortZipping) throw new Error("用户取消打包");
            const len = Math.min(blockSize, sampleCount - i);
            const leftChunk = leftSamples.subarray(i, i + len);
            const rightChunk = rightSamples ? rightSamples.subarray(i, i + len) : null;

            const mp3buf = rightChunk 
                ? mp3encoder.encodeBuffer(leftChunk, rightChunk) 
                : mp3encoder.encodeBuffer(leftChunk);

            if (mp3buf && mp3buf.length > 0) {
                mp3Chunks.push(mp3buf);
            }

            if (i % (blockSize * 4) === 0 || i + len >= sampleCount) {
                const pct = Math.round(((i + len) / sampleCount) * 100);
                if (onProgress) onProgress(pct);
                await new Promise(r => setTimeout(r, 0)); // 避免浏览器主线程假死
            }
        }

        const end = mp3encoder.flush();
        if (end && end.length > 0) {
            mp3Chunks.push(end);
        }

        const totalBytes = mp3Chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of mp3Chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }

    // --- 1. 创建 UI 容器 ---
    const panel = document.createElement("div");
    panel.id = "asmr-dl-panel";
    panel.style.cssText = `
        position: fixed;
        z-index: 9999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        color: #fff;
        user-select: none;
    `;

    const savedLeft = localStorage.getItem("asmr_dl_left");
    const savedTop = localStorage.getItem("asmr_dl_top");
    if (savedLeft && savedTop) {
        panel.style.left = savedLeft;
        panel.style.top = savedTop;
    } else {
        panel.style.bottom = "80px";
        panel.style.left = "20px";
    }

    panel.innerHTML = `
        <div id="dl-toggle-btn" style="background: linear-gradient(135deg, #7c4dff, #00e5ff); color: #fff; padding: 7px 14px; border-radius: 20px; cursor: pointer; box-shadow: 0 4px 15px rgba(124,77,255,0.4); display: flex; align-items: center; gap: 6px; font-weight: bold; width: fit-content;">
            <span>📦 目录下载打包器</span>
            <span id="dl-badge" style="background: rgba(0,0,0,0.6); color: #00e5ff; padding: 1px 6px; border-radius: 10px; font-size: 10px;">0</span>
        </div>

        <div id="dl-modal" style="display: none; width: 400px; max-height: 580px; background: rgba(18, 18, 26, 0.98); border: 1px solid #7c4dff; border-radius: 12px; padding: 14px; margin-top: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.85); flex-direction: column; gap: 10px;">
            <div id="dl-drag-header" style="cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px;">
                <b style="color: #b388ff; font-size: 13px;" id="dl-work-title">📦 ASMR 树状目录打包器 (按住拖动)</b>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <button id="dl-refresh-btn" style="background: none; border: none; color: #00e5ff; cursor: pointer; font-size: 12px;" title="重新解析">🔄 刷新</button>
                    <span id="dl-close-btn" style="cursor: pointer; color: #aaa; font-size: 16px; padding: 0 4px;">✕</span>
                </div>
            </div>

            <!-- 核心：ZIP 一键打包按钮 -->
            <button id="btn-zip-dl" style="background: linear-gradient(135deg, #7c4dff, #00b0ff); color: #fff; border: none; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 14px rgba(124,77,255,0.4); transition: filter 0.2s;">
                <span>📦 一键打包下载 ZIP (保持完整层级结构)</span>
            </button>

            <!-- WAV 自动转压缩流智能选项 -->
            <div style="background: rgba(124, 77, 255, 0.15); border: 1px solid rgba(124, 77, 255, 0.4); padding: 6px 10px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; font-size: 11px;">
                <label style="cursor: pointer; display: flex; align-items: center; gap: 6px; user-select: none;">
                    <input type="checkbox" id="cb-convert-wav" checked style="cursor: pointer; accent-color: #00e5ff;">
                    <span>🎵 遇到 WAV 自动下载高音质压缩音频 <b style="color: #ffd700;">(极速秒下/体积直降90%)</b></span>
                </label>
            </div>

            <!-- ZIP 打包实时进度条浮层 -->
            <div id="dl-zip-progress-box" style="display: none; background: rgba(124, 77, 255, 0.15); border: 1px solid #7c4dff; border-radius: 8px; padding: 10px; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <b id="dl-progress-title" style="color: #00e5ff; font-size: 11px;">准备下载...</b>
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <button id="btn-zip-skip" style="background: #ff9800; color: #fff; border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 10px; font-weight: bold;" title="跳过当前卡住的文件，直接打包已下载好的内容">⏭️ 跳过并打包</button>
                        <button id="btn-zip-cancel" style="background: #ff5252; color: #fff; border: none; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 10px;">✕ 取消</button>
                    </div>
                </div>
                <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                    <div id="dl-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #7c4dff, #00e5ff); transition: width 0.2s;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: #ccc;">
                    <span id="dl-progress-detail" style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">准备下载...</span>
                    <span id="dl-progress-size">0 MB</span>
                </div>
                <!-- 手动下载备用按钮容器 -->
                <div id="dl-manual-download-container" style="display: none; margin-top: 4px;"></div>
            </div>

            <!-- 其他辅助功能 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                <button id="btn-batch-dl" style="background: #282a36; color: #f8f9fa; border: 1px solid #555; padding: 6px; border-radius: 6px; cursor: pointer; font-size: 11px;">⬇️ 浏览器单独下载</button>
                <button id="btn-download-cover" style="background: #282a36; color: #ffd700; border: 1px solid #ffd700; padding: 6px; border-radius: 6px; cursor: pointer; font-size: 11px;">🖼️ 下载高清封面</button>
                <button id="btn-copy-links" style="background: #282a36; color: #00e5ff; border: 1px solid #00e5ff; padding: 6px; border-radius: 6px; cursor: pointer; font-size: 11px;">📋 复制直链 (IDM)</button>
                <button id="btn-export-txt" style="background: #282a36; color: #4cd964; border: 1px solid #4cd964; padding: 6px; border-radius: 6px; cursor: pointer; font-size: 11px;">📄 导出带路径 TXT (Aria2)</button>
            </div>

            <!-- 全选与统计 -->
            <div style="font-size: 11px; color: #aaa; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <label style="cursor: pointer; display: flex; align-items: center; gap: 4px;">
                        <input type="checkbox" id="cb-select-all" checked style="cursor: pointer; accent-color: #7c4dff;">
                        <span>全选所有</span>
                    </label>
                    <span id="btn-invert-select" style="color: #00e5ff; cursor: pointer; text-decoration: underline;">反选</span>
                </div>
                <span>已选音频: <b id="dl-selected-count" style="color: #4cd964;">0</b> / <span id="dl-file-count">0</span></span>
            </div>

            <!-- 树状目录清单滚动区 -->
            <div id="dl-file-tree" style="flex: 1; overflow-y: auto; max-height: 250px; display: flex; flex-direction: column; gap: 4px; padding-right: 4px;">
                <div style="color: #777; text-align: center; margin-top: 20px;">正在获取作品目录树...</div>
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    const toggleBtn = document.getElementById("dl-toggle-btn");
    const modal = document.getElementById("dl-modal");
    const closeBtn = document.getElementById("dl-close-btn");
    const refreshBtn = document.getElementById("dl-refresh-btn");
    const dragHeader = document.getElementById("dl-drag-header");
    const cbSelectAll = document.getElementById("cb-select-all");
    const btnInvertSelect = document.getElementById("btn-invert-select");
    const cbConvertWav = document.getElementById("cb-convert-wav");
    const zipProgressBox = document.getElementById("dl-zip-progress-box");
    const progressBar = document.getElementById("dl-progress-bar");
    const progressTitle = document.getElementById("dl-progress-title");
    const progressDetail = document.getElementById("dl-progress-detail");
    const progressSize = document.getElementById("dl-progress-size");
    const btnZipSkip = document.getElementById("btn-zip-skip");
    const btnZipCancel = document.getElementById("btn-zip-cancel");
    const manualContainer = document.getElementById("dl-manual-download-container");

    const savedConvertWav = localStorage.getItem("asmr_dl_convert_wav");
    if (savedConvertWav !== null) {
        cbConvertWav.checked = (savedConvertWav === "true");
    }
    cbConvertWav.onchange = () => {
        localStorage.setItem("asmr_dl_convert_wav", cbConvertWav.checked);
    };

    btnZipSkip.onclick = () => {
        if (!isZipping) return;
        skipZipping = true;
        progressTitle.innerText = "⚡ 正在跳过卡顿文件，立即封装已下载内容...";
    };

    toggleBtn.onclick = () => { modal.style.display = modal.style.display === "none" ? "flex" : "none"; };
    closeBtn.onclick = () => { modal.style.display = "none"; };
    refreshBtn.onclick = () => { if (currentRJ) fetchWorkData(currentRJ); };
    btnZipCancel.onclick = () => {
        abortZipping = true;
        progressTitle.innerText = "正在取消...";
    };

    // --- 2. 拖拽逻辑 ---
    let isDragging = false, startX, startY, initLeft, initTop;
    dragHeader.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.id === 'dl-close-btn') return;
        isDragging = true; startX = e.clientX; startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initLeft = rect.left; initTop = rect.top;
        panel.style.bottom = "auto"; panel.style.right = "auto";
        panel.style.left = initLeft + "px"; panel.style.top = initTop + "px";
        e.preventDefault();
    };
    document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        panel.style.left = Math.max(10, Math.min(window.innerWidth - modal.offsetWidth - 10, initLeft + e.clientX - startX)) + "px";
        panel.style.top = Math.max(10, Math.min(window.innerHeight - modal.offsetHeight - 10, initTop + e.clientY - startY)) + "px";
    });
    document.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            localStorage.setItem("asmr_dl_left", panel.style.left);
            localStorage.setItem("asmr_dl_top", panel.style.top);
        }
    });

    // --- 3. 递归构建与规范化树形数据 ---
    function processTree(nodes, currentPath = "") {
        if (!Array.isArray(nodes)) return [];
        return nodes.map(node => {
            const path = currentPath ? `${currentPath}/${node.title}` : node.title;
            if (node.type === 'folder' && node.children) {
                return {
                    id: Math.random().toString(36).substring(2),
                    type: 'folder',
                    title: node.title,
                    path: path,
                    selected: true,
                    expanded: true,
                    children: processTree(node.children, path)
                };
            } else {
                const item = {
                    id: Math.random().toString(36).substring(2),
                    type: 'file',
                    title: node.title,
                    fullPath: path,
                    url: node.mediaDownloadUrl || node.mediaStreamUrl,
                    streamLowQualityUrl: node.streamLowQualityUrl || "",
                    selected: true
                };
                flatFileList.push(item);
                return item;
            }
        });
    }

    function setNodeSelection(node, isSelected) {
        node.selected = isSelected;
        if (node.type === 'folder' && node.children) {
            node.children.forEach(child => setNodeSelection(child, isSelected));
        }
    }

    function updateSelectionCount() {
        const selectedCount = flatFileList.filter(f => f.selected).length;
        document.getElementById("dl-selected-count").innerText = selectedCount;
        cbSelectAll.checked = (selectedCount === flatFileList.length && flatFileList.length > 0);
    }

    cbSelectAll.onchange = (e) => {
        const val = e.target.checked;
        rawTreeData.forEach(n => setNodeSelection(n, val));
        renderTreeView();
    };

    btnInvertSelect.onclick = () => {
        flatFileList.forEach(f => f.selected = !f.selected);
        function refreshFolders(nodes) {
            nodes.forEach(n => {
                if (n.type === 'folder' && n.children) {
                    refreshFolders(n.children);
                    n.selected = n.children.some(c => c.selected);
                }
            });
        }
        refreshFolders(rawTreeData);
        renderTreeView();
    };

    // --- 4. 树形 UI 渲染器 ---
    function renderTreeView() {
        const container = document.getElementById("dl-file-tree");
        if (flatFileList.length === 0) {
            container.innerHTML = '<div style="color: #777; text-align: center; margin-top: 20px;">正在获取作品目录树...</div>';
            return;
        }

        container.innerHTML = "";

        function createTreeDOM(nodes, depth = 0) {
            const fragment = document.createDocumentFragment();
            nodes.forEach(node => {
                const row = document.createElement("div");
                row.style.cssText = `padding-left: ${depth * 14}px; display: flex; flex-direction: column;`;

                const line = document.createElement("div");
                line.style.cssText = `
                    display: flex; justify-content: space-between; align-items: center;
                    background: ${node.type === 'folder' ? 'rgba(124, 77, 255, 0.12)' : 'rgba(255, 255, 255, 0.03)'};
                    padding: 4px 6px; border-radius: 4px; margin-bottom: 2px;
                `;

                const leftPart = document.createElement("div");
                leftPart.style.cssText = "display: flex; align-items: center; gap: 6px; max-width: 300px;";

                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.checked = node.selected;
                cb.style.cssText = "cursor: pointer; accent-color: #7c4dff;";
                cb.onchange = (e) => {
                    setNodeSelection(node, e.target.checked);
                    renderTreeView();
                };

                const icon = document.createElement("span");
                icon.innerText = node.type === 'folder' ? '📁' : '🎵';
                icon.style.cursor = node.type === 'folder' ? 'pointer' : 'default';

                const title = document.createElement("span");
                title.innerText = node.title;
                title.title = node.path || node.fullPath;
                title.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;";
                if (node.type === 'folder') {
                    title.style.fontWeight = "bold";
                    title.style.color = "#b388ff";
                    title.style.cursor = "pointer";
                }

                if (node.type === 'folder') {
                    const toggleExpand = () => {
                        node.expanded = !node.expanded;
                        renderTreeView();
                    };
                    icon.onclick = toggleExpand;
                    title.onclick = toggleExpand;
                }

                leftPart.appendChild(cb);
                leftPart.appendChild(icon);
                leftPart.appendChild(title);
                line.appendChild(leftPart);

                row.appendChild(line);

                if (node.type === 'folder' && node.children && node.expanded) {
                    row.appendChild(createTreeDOM(node.children, depth + 1));
                }

                fragment.appendChild(row);
            });
            return fragment;
        }

        container.appendChild(createTreeDOM(rawTreeData));
        updateSelectionCount();
    }

    // --- 5. 跨域网络请求 (采用 ArrayBuffer 直通传输，彻底避免 Blob 桥接死锁) ---
    function gmFetchJSON(url, token = "") {
        return new Promise((resolve, reject) => {
            const headers = { "Accept": "application/json" };
            if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: headers,
                timeout: 30000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try { resolve(JSON.parse(res.responseText)); } catch(e) { reject(e); }
                    } else { reject(new Error(`HTTP ${res.status}`)); }
                },
                onerror: (err) => reject(err),
                ontimeout: () => reject(new Error("网络请求超时 (30s)"))
            });
        });
    }

    function gmFetchArrayBuffer(url, token = "", timeoutMs = 25000, onProgress = null) {
        return new Promise((resolve, reject) => {
            if (!url) return reject(new Error("下载地址为空"));
            const headers = {};
            if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

            let timer = null;
            let req = null;
            let isDone = false;

            const cleanup = () => {
                isDone = true;
                if (timer) { clearTimeout(timer); timer = null; }
            };

            // 原生 JavaScript 绝对看门狗定时器 (25秒强行断开并抛错，彻底杜绝网络假死)
            timer = setTimeout(() => {
                if (!isDone) {
                    cleanup();
                    try { if (req && req.abort) req.abort(); } catch(e) {}
                    reject(new Error(`网络请求超时 (${Math.round(timeoutMs/1000)}s)`));
                }
            }, timeoutMs);

            try {
                req = GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    headers: headers,
                    responseType: "arraybuffer",
                    timeout: timeoutMs,
                    onprogress: (p) => {
                        if (!isDone && onProgress) onProgress(p);
                    },
                    onload: (res) => {
                        if (isDone) return;
                        cleanup();
                        if (res.status >= 200 && res.status < 300) {
                            resolve(res.response);
                        } else {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    },
                    onerror: (err) => {
                        if (isDone) return;
                        cleanup();
                        reject(err);
                    },
                    ontimeout: () => {
                        if (isDone) return;
                        cleanup();
                        reject(new Error(`网络请求超时 (${Math.round(timeoutMs/1000)}s)`));
                    }
                });
            } catch(e) {
                cleanup();
                reject(e);
            }
        });
    }

    async function fetchWorkData(rjCode) {
        if (isFetching) return;
        isFetching = true;

        const numId = rjCode.replace(/\D/g, "");
        const numIdNoZero = numId.replace(/^0+/, "");
        const token = localStorage.getItem("token") || localStorage.getItem("jwt") || sessionStorage.getItem("token") || "";

        const endpoints = [
            `https://api.asmr.one/api/tracks/${rjCode}`,
            `https://api.asmr.one/api/tracks/${numIdNoZero}`,
            `/api/tracks/${rjCode}`,
            `/api/tracks/${numIdNoZero}`
        ];

        flatFileList = [];
        rawTreeData = [];

        for (const ep of endpoints) {
            try {
                const data = await gmFetchJSON(ep, token);
                if (data && Array.isArray(data) && data.length > 0) {
                    rawTreeData = processTree(data);
                    break;
                }
            } catch(e) {}
        }

        try {
            const meta = await gmFetchJSON(`https://api.asmr.one/api/work/${rjCode}`, token);
            if (meta) {
                currentWorkTitle = meta.title || currentWorkTitle;
                coverUrl = meta.mainCoverUrl || "";
            }
        } catch(e) {
            currentWorkTitle = document.title.replace(/\|.*$/, "").trim() || currentWorkTitle;
        }

        document.getElementById("dl-badge").innerText = flatFileList.length;
        document.getElementById("dl-file-count").innerText = flatFileList.length;
        document.getElementById("dl-work-title").innerText = (currentRJ ? `[${currentRJ}] ` : "") + currentWorkTitle.slice(0, 15) + (currentWorkTitle.length > 15 ? "..." : "");

        renderTreeView();
        isFetching = false;
    }

    function checkCurrentURL() {
        const match = window.location.href.match(/(RJ\d{6,8}|VJ\d{6,8}|BJ\d{6,8})/i);
        if (match) {
            const rj = match[1].toUpperCase();
            if (rj !== currentRJ) {
                currentRJ = rj;
                fetchWorkData(rj);
            }
        }
    }
    setInterval(checkCurrentURL, 1000);
    checkCurrentURL();

    function getSelectedFiles() {
        const selected = flatFileList.filter(f => f.selected);
        if (selected.length === 0) {
            alert("请至少勾选一个音频文件！");
            return null;
        }
        return selected;
    }

    // --- 6. 核心：一键打包 ZIP 压缩包下载（fflate 流式极速引擎，彻底杜绝大文件卡死） ---
    async function startZipDownload() {
        if (isZipping) {
            alert("当前正在打包下载中，请稍候！");
            return;
        }

        const selected = getSelectedFiles();
        if (!selected) return;

        let fflateEngine;
        try {
            fflateEngine = await ensureFflate();
        } catch(e) {
            alert("初始化压缩引擎失败: " + e.message);
            return;
        }

        const rootFolder = currentRJ || "ASMR";
        const safeTitle = currentWorkTitle.replace(/[\\/:*?"<>|]/g, "_").trim();
        const zipFileName = `${rootFolder}_${safeTitle.slice(0, 25)}.zip`;
        const autoConvertWav = cbConvertWav ? cbConvertWav.checked : true;

        isZipping = true;
        abortZipping = false;

        manualContainer.style.display = "none";
        manualContainer.innerHTML = "";
        btnZipCancel.style.display = "inline-block";
        btnZipSkip.style.display = "inline-block";
        zipProgressBox.style.display = "flex";
        progressBar.style.width = "0%";
        progressTitle.innerText = `准备流式打包 (${selected.length} 个文件)...`;

        const chunks = [];
        let zipErrOccurred = null;

        // 初始化 fflate 流式 ZIP 容器 (极低内存占用，原生 TypedArray)
        const zip = new fflateEngine.Zip((err, chunk, final) => {
            if (err) {
                console.error("[fflate] 流错误:", err);
                zipErrOccurred = err;
                return;
            }
            if (chunk && chunk.length > 0) {
                chunks.push(chunk);
            }
        });

        // 串行写入锁，确保多并发下载的数据块按顺序追加至 ZIP 规范流中
        let zipLock = Promise.resolve();
        function pushToZipStream(relativePath, uint8Data) {
            zipLock = zipLock.then(() => {
                if (abortZipping) return;
                const fileEntry = new fflateEngine.ZipPassThrough(relativePath);
                zip.add(fileEntry);
                fileEntry.push(uint8Data, true);
            });
            return zipLock;
        }

        let downloadedBytes = 0;
        let downloadedCount = 0;
        const token = localStorage.getItem("token") || localStorage.getItem("jwt") || sessionStorage.getItem("token") || "";

        // 1. 如果包含封面，先推入封面
        if (coverUrl) {
            try {
                const coverAb = await gmFetchArrayBuffer(coverUrl, token, 20000);
                await pushToZipStream(`${rootFolder}/cover.jpg`, new Uint8Array(coverAb));
            } catch(e) {
                console.warn("[ZIP] 封面获取跳过:", e);
            }
        }

        // 2. 并发下载队列 (并发数 2，兼顾下载速度与浏览器稳定)
        const queue = [...selected];
        const concurrency = 2;

        async function worker() {
            while (queue.length > 0 && !abortZipping && !skipZipping) {
                const item = queue.shift();
                progressDetail.innerText = `[${downloadedCount + 1}/${selected.length}] 连接中: ${item.title}`;

                try {
                    let fetchUrl = item.url;
                    let finalFullPath = item.fullPath;
                    const isWav = /\.wav$/i.test(item.fullPath);
                    let usedCdnStream = false;

                    // 1. 核心提速突破：若开启压缩且服务端已预转码为高品质 AAC/M4A 流
                    if (autoConvertWav && isWav && item.streamLowQualityUrl) {
                        fetchUrl = item.streamLowQualityUrl;
                        finalFullPath = item.fullPath.replace(/\.wav$/i, ".m4a");
                        usedCdnStream = true;
                    }

                    let ab = null;
                    let fetchSuccess = false;

                    // 最多尝试 2 次下载，带 25 秒原生 JS 看门狗定时器与传输字节更新
                    for (let attempt = 1; attempt <= 2 && !abortZipping && !skipZipping; attempt++) {
                        try {
                            ab = await gmFetchArrayBuffer(fetchUrl, token, 25000, (p) => {
                                if (p.loaded && p.total && !skipZipping) {
                                    const curMB = (p.loaded / (1024 * 1024)).toFixed(1);
                                    const totMB = (p.total / (1024 * 1024)).toFixed(1);
                                    progressDetail.innerText = `[${downloadedCount + 1}/${selected.length}] 传输中: ${item.title} (${curMB}/${totMB} MB)`;
                                }
                            });
                            fetchSuccess = true;
                            break;
                        } catch(fetchErr) {
                            console.warn(`[ZIP] 第 ${attempt} 次下载失败: ${item.title}`, fetchErr.message);
                            if (attempt === 1 && usedCdnStream) {
                                // 容错切换：CDN 流失败则切回原始源站
                                fetchUrl = item.url;
                                finalFullPath = item.fullPath;
                                usedCdnStream = false;
                            }
                            await new Promise(r => setTimeout(r, 600));
                        }
                    }

                    if (skipZipping || abortZipping) {
                        if (skipZipping) queue.length = 0; // 彻底清空剩余队列
                        break;
                    }

                    if (!fetchSuccess || !ab) {
                        downloadedCount++;
                        console.warn("[ZIP] 文件连接超时，已自动安全跳过:", item.title);
                        progressDetail.innerText = `[${downloadedCount}/${selected.length}] 超时跳过: ${item.title}`;
                        continue;
                    }

                    let finalData = new Uint8Array(ab);

                    // 2. 备用保障：极少数情况下若服务端没有提供预压缩流且用户勾选了压缩，才在前端执行转码
                    if (autoConvertWav && isWav && !usedCdnStream) {
                        try {
                            progressDetail.innerText = `[${downloadedCount + 1}/${selected.length}] 正在转码 MP3: ${item.title}...`;
                            finalData = await convertWavToMp3(ab, (pct) => {
                                progressDetail.innerText = `[${downloadedCount + 1}/${selected.length}] 正在转为 MP3 (${pct}%): ${item.title}`;
                            });
                            finalFullPath = item.fullPath.replace(/\.wav$/i, ".mp3");
                        } catch(convErr) {
                            console.warn("[ZIP] WAV 转 MP3 失败，保留原始 WAV:", convErr);
                            finalData = new Uint8Array(ab);
                        }
                    }

                    downloadedBytes += finalData.byteLength;
                    downloadedCount++;

                    // 规范化文件相对路径，实时直接推入 ZIP 流中，完成后该 ArrayBuffer 可立即被 V8 释放
                    const zipPath = `${rootFolder}/${finalFullPath}`;
                    await pushToZipStream(zipPath, finalData);

                    const percent = Math.round((downloadedCount / selected.length) * 96);
                    progressBar.style.width = `${percent}%`;
                    progressSize.innerText = `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`;
                    progressDetail.innerText = `[${downloadedCount}/${selected.length}] 已写入 ZIP: ${finalFullPath.split('/').pop()}`;
                } catch(err) {
                    console.error("[ZIP] 下载单文件异常:", item.fullPath, err);
                    downloadedCount++;
                    progressDetail.innerText = `[${downloadedCount}/${selected.length}] 异常跳过: ${item.title}`;
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
        await Promise.all(workers);

        if (abortZipping) {
            chunks.length = 0;
            zipProgressBox.style.display = "none";
            btnZipSkip.style.display = "none";
            isZipping = false;
            skipZipping = false;
            alert("已取消 ZIP 打包下载！内存已释放。");
            return;
        }

        if (zipErrOccurred) {
            alert("ZIP 流式压缩出现错误: " + zipErrOccurred.message);
            zipProgressBox.style.display = "none";
            btnZipSkip.style.display = "none";
            isZipping = false;
            skipZipping = false;
            return;
        }

        // 3. 构建收尾：此时所有文件早已在下载过程中流式写入完毕，仅需耗时 0.05 秒完成中央目录封口
        progressTitle.innerText = "⚡ 正在完成 ZIP 封口...";
        progressBar.style.width = "99%";
        progressDetail.innerText = `正在写入 ZIP 目录索引 (已打包 ${downloadedCount} 个文件)...`;

        try {
            await zipLock;
            zip.end();

            progressBar.style.width = "100%";
            progressTitle.innerText = "✅ ZIP 生成完毕！";
            progressDetail.innerText = "已自动触发保存，若浏览器拦截请点击下方绿色按钮：";

            const zipBlob = new Blob(chunks, { type: "application/zip" });
            const blobUrl = URL.createObjectURL(zipBlob);
            const sizeMB = (zipBlob.size / (1024 * 1024)).toFixed(1);

            // 自动触发浏览器保存
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = zipFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // 同时渲染醒目的手动下载备用按钮
            manualContainer.style.display = "block";
            manualContainer.innerHTML = `
                <a id="btn-manual-save-zip" href="${blobUrl}" download="${zipFileName}" style="display: block; background: #4cd964; color: #000; text-align: center; padding: 8px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; box-shadow: 0 2px 8px rgba(76,217,100,0.4);">
                    💾 点击直接保存 ZIP 压缩包 (${sizeMB} MB)
                </a>
            `;

            btnZipCancel.style.display = "none";
            btnZipSkip.style.display = "none";
            isZipping = false;
            skipZipping = false;

        } catch(zipErr) {
            console.error("生成 ZIP 失败:", zipErr);
            alert("生成 ZIP 失败: " + zipErr.message);
            zipProgressBox.style.display = "none";
            btnZipSkip.style.display = "none";
            isZipping = false;
            skipZipping = false;
        }
    }

    document.getElementById("btn-zip-dl").onclick = startZipDownload;

    // --- 7. 辅助功能（单独下载、复制直链、Aria2导出） ---
    function downloadWithFolder(url, relativePath) {
        const savePath = `${currentRJ || 'ASMR'}/${relativePath}`;
        if (typeof GM_download !== 'undefined') {
            GM_download({ url: url, name: savePath, saveAs: false });
        } else {
            const a = document.createElement("a");
            a.href = url;
            a.download = relativePath.split('/').pop();
            a.target = "_blank";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }

    document.getElementById("btn-copy-links").onclick = () => {
        const selected = getSelectedFiles();
        if (!selected) return;
        const urls = selected.map(f => f.url).join("\n");
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(urls);
        } else {
            navigator.clipboard.writeText(urls);
        }
        alert(`✅ 已复制 ${selected.length} 个直链！\n在 IDM / 迅雷 中按 Ctrl+V 批量下载。`);
    };

    document.getElementById("btn-export-txt").onclick = () => {
        const selected = getSelectedFiles();
        if (!selected) return;
        let content = `# 作品: ${currentWorkTitle} (${currentRJ})\n# Aria2 目录结构自动保持配置\n\n`;
        selected.forEach(f => {
            const parts = f.fullPath.split('/');
            const filename = parts.pop();
            const subDir = parts.join('/');
            const targetDir = subDir ? `${currentRJ}/${subDir}` : `${currentRJ}`;
            content += `${f.url}\n  dir=${targetDir}\n  out=${filename}\n`;
        });
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${currentRJ || 'ASMR'}_目录结构下载清单(${selected.length}首).txt`;
        a.click();
    };

    document.getElementById("btn-batch-dl").onclick = () => {
        const selected = getSelectedFiles();
        if (!selected) return;
        if (!confirm(`即将开始分文件下载 ${selected.length} 个音频，建议优先使用上方的“一键打包 ZIP”功能以完美保留文件夹。\n是否继续单独下载？`)) return;
        selected.forEach((item, i) => {
            setTimeout(() => { downloadWithFolder(item.url, item.fullPath); }, i * 600);
        });
    };

    document.getElementById("btn-download-cover").onclick = () => {
        if (!coverUrl) { alert("未找到封面图片！"); return; }
        downloadWithFolder(coverUrl, `cover.jpg`);
    };
})();
