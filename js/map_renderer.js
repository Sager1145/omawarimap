export function createMap(elementId) {
  const container = document.getElementById(elementId);
  const map = L.map(container, {
    zoomControl: true,
    preferCanvas: false
  }).setView([35.681236, 139.767125], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const resize = () => map.invalidateSize({ pan: false });
  window.addEventListener("resize", resize);
  requestAnimationFrame(resize);

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(resize);
    observer.observe(container);
  }

  return map;
}
