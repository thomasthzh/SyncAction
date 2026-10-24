/* global document, navigator */
const copyButton = document.querySelector("#copy-server");
const serverAddress = document.querySelector("#server-address");
const copyStatus = document.querySelector("#copy-status");
if (copyButton && serverAddress && copyStatus) {
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(serverAddress.value);
      copyStatus.textContent = "已复制。到扩展侧栏的“配置服务器”中粘贴。";
    } catch {
      serverAddress.focus();
      serverAddress.select();
      copyStatus.textContent = "请手动复制已选中的地址，再到扩展侧栏粘贴。";
    }
  });
}
