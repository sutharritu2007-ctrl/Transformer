
const inspectButton = document.getElementById("inspect");

inspectButton.addEventListener("click", async () => {
    inspectButton.textContent = "Inspecting...";
    inspectButton.disabled = true;

    try {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        // Ask content.js to inspect the webpage.
        const response = await chrome.tabs.sendMessage(tab.id, {
            type: "INSPECT_PAGE"
        });

        if (!response?.success) {
            throw new Error("Inspection failed.");
        }

        alert(
            `Page: ${response.data.title}\n` +
            `Website: ${response.data.url}\n` +
            `Elements found: ${response.data.elementCount}`
        );
    } catch (error) {
        console.error("Transformer inspection error:", error);

        alert(
            "Transformer couldn't inspect this page.\n" +
            "Reload the extension and webpage, then try again."
        );
    } finally {
        inspectButton.textContent = "Inspect Page";
        inspectButton.disabled = false;
    }
});
