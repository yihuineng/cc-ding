/**
 * Mobile touch support for Monaco Editor
 * Enables text selection on iOS and Android browsers
 */

export function enableMobileTextSelection(editor: any): void {
  if (!editor || typeof window === 'undefined') return;

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (!isMobile) return;

  const editorElement = editor.getDomNode();
  if (!editorElement) return;

  let touchStartTime = 0;
  let touchStartPos = { x: 0, y: 0 };
  let isLongPress = false;
  let longPressTimer: NodeJS.Timeout | null = null;

  // Handle touch start
  const handleTouchStart = (e: TouchEvent) => {
    touchStartTime = Date.now();
    const touch = e.touches[0];
    touchStartPos = { x: touch.clientX, y: touch.clientY };
    isLongPress = false;

    // Start long press timer (500ms)
    longPressTimer = setTimeout(() => {
      isLongPress = true;
      // Enable text selection mode
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        const target = e.target as HTMLElement;
        if (target && target.nodeType === Node.TEXT_NODE) {
          range.selectNodeContents(target);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }, 500);
  };

  // Handle touch end
  const handleTouchEnd = (e: TouchEvent) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    const touchEndTime = Date.now();
    const touch = e.changedTouches[0];
    const touchEndPos = { x: touch.clientX, y: touch.clientY };

    // If it's a quick tap (not a long press or swipe), let default behavior handle it
    if (!isLongPress && touchEndTime - touchStartTime < 300) {
      const distance = Math.sqrt(
        Math.pow(touchEndPos.x - touchStartPos.x, 2) +
        Math.pow(touchEndPos.y - touchStartPos.y, 2)
      );

      // If it's a tap (not a swipe)
      if (distance < 10) {
        // Allow default selection behavior
        return;
      }
    }
  };

  // Handle touch move
  const handleTouchMove = (e: TouchEvent) => {
    // Cancel long press if user moves finger
    if (longPressTimer && !isLongPress) {
      const touch = e.touches[0];
      const distance = Math.sqrt(
        Math.pow(touch.clientX - touchStartPos.x, 2) +
        Math.pow(touch.clientY - touchStartPos.y, 2)
      );

      // If moved more than 10px, cancel long press
      if (distance > 10) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  };

  // Add event listeners
  editorElement.addEventListener('touchstart', handleTouchStart, { passive: true });
  editorElement.addEventListener('touchend', handleTouchEnd, { passive: true });
  editorElement.addEventListener('touchmove', handleTouchMove, { passive: true });

  // Cleanup function
  return () => {
    editorElement.removeEventListener('touchstart', handleTouchStart);
    editorElement.removeEventListener('touchend', handleTouchEnd);
    editorElement.removeEventListener('touchmove', handleTouchMove);
    if (longPressTimer) {
      clearTimeout(longPressTimer);
    }
  };
}
