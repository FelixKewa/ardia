export function revealedOffset(index: number, offset: number, viewport: number, card: number, stride: number) {
  const left = index * stride;
  const right = left + card;
  if (left < offset) return left;
  if (right > offset + viewport) return right - viewport;
  return offset;
}

export function pointerOnVisiblePart(index: number, clientX: number, offset: number, viewport: number, stride: number) {
  const x = index * stride + clientX;
  return x >= offset - 0.5 && x <= offset + viewport + 0.5;
}
