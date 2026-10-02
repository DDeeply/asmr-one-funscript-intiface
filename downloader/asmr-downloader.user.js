// ==UserScript==
// @name         ASMR.one (Kikoeru) 全能音频批量下载器 (一键打包 ZIP 保持目录结构版)
// @namespace    https://github.com/ykcjack/asmr-one-tools
// @version      2.0.0
// @description  完整保持 ASMR.one 原始文件夹层级结构，一键打包下载全部或勾选音频为标准 ZIP 压缩包，解压后完美还原所有子文件夹，绝不混淆；内置实时进度条、树状目录折叠全选/反选与封面整合。
// @author       ykcjack
// @match        https://www.asmr.one/*
// @match        https://asmr.one/*
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
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

    console.log("[ASMR-Downloader] v2.0 一键 ZIP 目录压缩打包版启动...");

    let currentWorkTitle = "ASMR作品";
    let currentRJ = "";
    let rawTreeData = []; // 原始树形结构
    let flatFileList = []; // 扁平文件引用列表，便于快速统计
    let coverUrl = "";
    let isFetching = false;
    let isZipping = false;
    let abortZipping = false;

    // --- 确保 JSZip 库可用 ---
    function ensureJSZip() {
        return new Promise((resolve, reject) => {
            if (typeof JSZip !== "undefined") {
                return resolve(window.JSZip);
            }
            const s1 = document.createElement("script");
            s1.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
            s1.onload = () => resolve(window.JSZip);
            s1.onerror = () => {
                const s2 = document.createElement("script");
                s2.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
                s2.onload = () => resolve(window.JSZip);
                s2.onerror = () => reject(new Error("无法加载 JSZip 库，请检查网络连接！"));
                document.head.appendChild(s2);
            };
            document.head.appendChild(s1);
        });
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
            <!-- 拖拽顶栏 -->
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

            <!-- ZIP 打包实时进度条浮层 (默认隐藏) -->
            <div id="dl-zip-progress-box" style="display: none; background: rgba(124, 77, 255, 0.15); border: 1px solid #7c4dff; border-radius: 8px; padding: 8px 10px; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <b id="dl-progress-title" style="color: #00e5ff; font-size: 11px;">正在打包...</b>
                    <button id="btn-zip-cancel" style="background: #ff5252; color: #fff; border: none; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 10px;">✕ 取消</button>
                </div>
                <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                    <div id="dl-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #7c4dff, #00e5ff); transition: width 0.2s;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: #ccc;">
                    <span id="dl-progress-detail">准备下载...</span>
                    <span id="dl-progress-size">0 MB</span>
                </div>
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
    const zipProgressBox = document.getElementById("dl-zip-progress-box");
    const progressBar = document.getElementById("dl-progress-bar");
    const progressTitle = document.getElementById("dl-progress-title");
    const progressDetail = document.getElementById("dl-progress-detail");
    const progressSize = document.getElementById("dl-progress-size");
    const btnZipCancel = document.getElementById("btn-zip-cancel");

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

    // --- 5. 跨域网络请求 ---
    function gmFetchJSON(url, token = "") {
        return new Promise((resolve, reject) => {
            const headers = { "Accept": "application/json" };
            if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: headers,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try { resolve(JSON.parse(res.responseText)); } catch(e) { reject(e); }
                    } else { reject(new Error(`HTTP ${res.status}`)); }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    function gmFetchBlob(url, token = "") {
        return new Promise((resolve, reject) => {
            const headers = {};
            if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: headers,
                responseType: "blob",
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(res.response);
                    } else {
                        reject(new Error(`HTTP ${res.status}`));
                    }
                },
                onerror: (err) => reject(err),
                ontimeout: () => reject(new Error("Timeout"))
            });
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

    // --- 6. 核心：一键打包 ZIP 压缩包下载（绝对保持目录结构） ---
    async function startZipDownload() {
        if (isZipping) {
            alert("当前正在打包下载中，请稍候！");
            return;
        }

        const selected = getSelectedFiles();
        if (!selected) return;

        let ZipLib;
        try {
            ZipLib = await ensureJSZip();
        } catch(e) {
            alert("初始化压缩引擎失败: " + e.message);
            return;
        }

        const rootFolder = currentRJ || "ASMR";
        const safeTitle = currentWorkTitle.replace(/[\\/:*?"<>|]/g, "_").trim();
        const zipFileName = `${rootFolder}_${safeTitle.slice(0, 25)}.zip`;

        isZipping = true;
        abortZipping = false;

        zipProgressBox.style.display = "flex";
        progressBar.style.width = "0%";
        progressTitle.innerText = `正在打包 ZIP (${selected.length} 个文件)...`;

        const zip = new ZipLib();
        let downloadedBytes = 0;
        let downloadedCount = 0;
        const token = localStorage.getItem("token") || localStorage.getItem("jwt") || sessionStorage.getItem("token") || "";

        // 如果包含封面，先打包封面
        if (coverUrl) {
            try {
                const coverBlob = await gmFetchBlob(coverUrl, token);
                zip.file(`${rootFolder}/cover.jpg`, coverBlob);
            } catch(e) {
                console.warn("[ZIP] 封面获取跳过:", e);
            }
        }

        // 并发队列（2个并发，兼顾速度与内存）
        const queue = [...selected];
        const concurrency = 2;

        async function worker() {
            while (queue.length > 0 && !abortZipping) {
                const item = queue.shift();
                progressDetail.innerText = `[${downloadedCount + 1}/${selected.length}] 下载: ${item.title}`;

                try {
                    const blob = await gmFetchBlob(item.url, token);
                    downloadedBytes += blob.size;
                    downloadedCount++;

                    // 规范化文件相对路径，存入 ZIP
                    const zipPath = `${rootFolder}/${item.fullPath}`;
                    zip.file(zipPath, blob);

                    const percent = Math.round((downloadedCount / selected.length) * 85); // 下载占 85% 进度
                    progressBar.style.width = `${percent}%`;
                    progressSize.innerText = `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`;
                } catch(err) {
                    console.error("[ZIP] 下载单曲失败:", item.fullPath, err);
                    downloadedCount++;
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
        await Promise.all(workers);

        if (abortZipping) {
            zipProgressBox.style.display = "none";
            isZipping = false;
            alert("已取消 ZIP 打包下载！");
            return;
        }

        progressTitle.innerText = "🗜️ 音频下载完成，正在构建生成 ZIP 文件...";
        progressBar.style.width = "90%";

        try {
            // 使用 STORE 存储压缩（音频本身已是 mp3/wav/flac 编码），速度极快，瞬间生成
            const zipBlob = await zip.generateAsync({
                type: "blob",
                compression: "STORE"
            }, (metadata) => {
                const p = 85 + Math.round(metadata.percent * 0.15);
                progressBar.style.width = `${p}%`;
                progressDetail.innerText = `压缩构建进度: ${Math.round(metadata.percent)}%`;
            });

            progressBar.style.width = "100%";
            progressTitle.innerText = "✅ 压缩完成，已触发浏览器保存！";

            // 触发下载
            const blobUrl = URL.createObjectURL(zipBlob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = zipFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            setTimeout(() => {
                URL.revokeObjectURL(blobUrl);
                zipProgressBox.style.display = "none";
                isZipping = false;
            }, 3000);

        } catch(zipErr) {
            alert("生成 ZIP 失败: " + zipErr.message);
            zipProgressBox.style.display = "none";
            isZipping = false;
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

    // 复制选中直链 (IDM 格式)
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

    // 导出带相对路径的清单 (Aria2 格式)
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

    // 浏览器批量自动按文件夹下载
    document.getElementById("btn-batch-dl").onclick = () => {
        const selected = getSelectedFiles();
        if (!selected) return;
        if (!confirm(`即将开始分文件下载 ${selected.length} 个音频，建议优先使用上方的“一键打包 ZIP”功能以完美保留文件夹。\n是否继续单独下载？`)) return;
        selected.forEach((item, i) => {
            setTimeout(() => { downloadWithFolder(item.url, item.fullPath); }, i * 600);
        });
    };

    // 下载封面
    document.getElementById("btn-download-cover").onclick = () => {
        if (!coverUrl) { alert("未找到封面图片！"); return; }
        downloadWithFolder(coverUrl, `cover.jpg`);
    };
})();
