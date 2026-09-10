// Applies the same saved CRT preference as the game page before painting.
try {
  const saved = localStorage.getItem("ldq-crt-effect");
  document.documentElement.classList.toggle("crt-disabled", saved === "off" || (saved === null && matchMedia("(prefers-reduced-motion: reduce)").matches));
} catch {
  document.documentElement.classList.toggle("crt-disabled", matchMedia("(prefers-reduced-motion: reduce)").matches);
}
