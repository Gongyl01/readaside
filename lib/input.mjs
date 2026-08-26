export function shouldSubmitOnEnter(event, compositionActive = false) {
  if (event?.key !== "Enter" || event?.shiftKey) return false;
  if (compositionActive || event?.isComposing || event?.keyCode === 229) return false;
  return true;
}
