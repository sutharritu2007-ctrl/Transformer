
const inspectButton = document.getElementById("inspect");
const downloadButton = document.getElementById("download");
const statusMessage = document.getElementById("status");
let latestBlueprint = null;

function setStatus(message) {
    statusMessage.textContent = message;
}

inspectButton.addEventListener("click", async () => {
    inspectButton.textContent = "Inspecting...";
    inspectButton.disabled = true;
    downloadButton.disabled = true;
    latestBlueprint = null;
    setStatus("Inspecting page...");

    try {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });
        if (!tab?.id) {
            throw new Error("No active webpage was found.");
        }

        // Install the listener even when this tab was already open at reload time.
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content/inspector.bundle.js", "content/content.js"]
        });

        const response = await chrome.tabs.sendMessage(tab.id, {
            type: "INSPECT_PAGE"
        });

        if (!response?.success) {
            throw new Error(response?.error || "The page inspection failed.");
        }

        latestBlueprint = response.data;
        downloadButton.disabled = false;
        setStatus(
            `Ready: ${latestBlueprint.limits.nodesKept} elements. Click Download JSON.`
        );
    } catch (error) {
        console.error("Transformer inspection error:", error);
        setStatus(`Inspection failed: ${error.message}`);
    } finally {
        inspectButton.textContent = "Inspect Page";
        inspectButton.disabled = false;
    }
});

downloadButton.addEventListener("click", () => {
    if (!latestBlueprint) {
        setStatus("Inspect a page first, then download its JSON.");
        downloadButton.disabled = true;
        return;
    }

    try {
        const blob = new Blob([JSON.stringify(latestBlueprint, null, 2)], {
            type: "application/json"
        });
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const host = latestBlueprint.meta.host || "page";
        const filename = `transformer-${host}-blueprint.json`;
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
        setStatus(`Download started: ${filename}`);
    } catch (error) {
        console.error("Transformer download error:", error);
        setStatus(`Download failed: ${error.message}`);
    }
});
