
(() => {
    // Prevent the inspector from being installed more than once.
    if (globalThis.__transformerInspectorInstalled) {
        return;
    }

    globalThis.__transformerInspectorInstalled = true;

    // Listen for inspection requests from the popup.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "INSPECT_PAGE") {
            return;
        }

        const result = {
            title: document.title,
            url: location.origin,
            elementCount: document.querySelectorAll("*").length
        };

        sendResponse({
            success: true,
            data: result
        });
    });
})();
