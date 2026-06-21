export function getComposerAnchor(
  visibleRowKeys: string[],
  selectedRowKeys: string[],
): string | null {
  if (selectedRowKeys.length === 0) {
    return null;
  }

  const visibleSelection = visibleRowKeys.filter((rowKey) =>
    selectedRowKeys.includes(rowKey),
  );
  return visibleSelection[visibleSelection.length - 1] ?? null;
}
