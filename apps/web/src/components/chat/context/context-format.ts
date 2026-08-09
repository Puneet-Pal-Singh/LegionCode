export function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatScaledCount(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${formatScaledCount(value / 1_000)}k`;
  }
  return String(value);
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCost(value: number, currency = "USD"): string {
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatScaledCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : value < 100 ? 1 : 0,
  }).format(value);
}
