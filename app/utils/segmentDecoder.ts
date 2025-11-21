/**
 * Extracts TS (Transport Stream) data from bytes that are wrapped with markers.
 * 
 * This function searches for start marker "<<<TS_DATA_START>>>" and end marker "<<<TS_DATA_END>>>"
 * in the provided byte array, and returns the TS data between these markers.
 * 
 * @param dataBytes - The byte array containing wrapped TS data
 * @returns The extracted TS data as Uint8Array, or null if markers are not found
 */
export function extractTSFromData(dataBytes: Uint8Array): Uint8Array | null {
  const startMarker = new TextEncoder().encode('<<<TS_DATA_START>>>');
  const endMarker = new TextEncoder().encode('<<<TS_DATA_END>>>');

  if (dataBytes.length < startMarker.length + endMarker.length) {
    return null;
  }

  const dataLen = dataBytes.length;
  const startMarkerLen = startMarker.length;
  const endMarkerLen = endMarker.length;

  // Optimized: Direct byte comparison function (inline for better performance)
  const matchMarker = (data: Uint8Array, marker: Uint8Array, pos: number): boolean => {
    if (pos + marker.length > data.length) {
      return false;
    }
    for (let j = 0; j < marker.length; j++) {
      if (data[pos + j] !== marker[j]) {
        return false;
      }
    }
    return true;
  };

  // Search for start marker (early exit if not found in reasonable portion)
  let startPos = -1;
  let maxSearchPos = dataLen - startMarkerLen;
  if (maxSearchPos > 1024) {
    maxSearchPos = 1024; // Limit initial search to first 1KB
  }

  for (let i = 0; i <= maxSearchPos; i++) {
    if (matchMarker(dataBytes, startMarker, i)) {
      startPos = i;
      break;
    }
  }

  // If not found in first 1KB, search the rest
  if (startPos === -1) {
    for (let i = maxSearchPos + 1; i <= dataLen - startMarkerLen; i++) {
      if (matchMarker(dataBytes, startMarker, i)) {
        startPos = i;
        break;
      }
    }
  }

  if (startPos === -1) {
    return null;
  }

  // Search for end marker starting from after start marker
  const tsStart = startPos + startMarkerLen;

  // Early exit: end marker must be after start marker
  if (tsStart + endMarkerLen > dataLen) {
    return null;
  }

  // Search for end marker
  for (let i = tsStart; i <= dataLen - endMarkerLen; i++) {
    if (matchMarker(dataBytes, endMarker, i)) {
      return dataBytes.slice(tsStart, i);
    }
  }

  return null;
}

