export const numberFormatter = new Intl.NumberFormat();

export const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
