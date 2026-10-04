export const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==";
export const PNG_BYTES = Uint8Array.from(
  atob(PNG_DATA_URL.split(",")[1]!),
  (character) => character.charCodeAt(0),
);
