import { NextRequest, NextResponse } from 'next/server';

const HLS_SERVER = 'http://127.0.0.1:8080';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathArray } = await params;
  const path = pathArray.join('/');
  const url = `${HLS_SERVER}/${path}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Accept': '*/*',
      },
    });

    if (!response.ok) {
      return new NextResponse(response.statusText, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || '';
    let body: string | ArrayBuffer;

    // If it's a playlist file, rewrite URLs
    if (contentType.includes('application/vnd.apple.mpegurl') || path.endsWith('.m3u8')) {
      const text = await response.text();
      // Get the base path of the current playlist (directory path)
      const pathParts = path.split('/');
      pathParts.pop(); // Remove filename
      const basePath = pathParts.length > 0 ? pathParts.join('/') + '/' : '';
      const baseProxyPath = `/api/hls/${basePath}`;
      
      // Rewrite absolute URLs to use proxy
      let rewritten = text.replace(
        /(https?:\/\/127\.0\.0\.1:8080\/|http:\/\/127\.0\.0\.1:8080\/)/g,
        '/api/hls/'
      );
      
      // Rewrite all URLs in playlist (lines that don't start with # and are not empty)
      rewritten = rewritten.split('\n').map((line) => {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (trimmed.startsWith('#') || trimmed === '') {
          return line;
        }
        // Skip if already rewritten to use proxy
        if (trimmed.startsWith('/api/hls/')) {
          return line;
        }
        // Skip if it's already an http/https URL (should have been rewritten above)
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          return line;
        }
        // If it starts with /, it's an absolute path from root - rewrite to use proxy
        if (trimmed.startsWith('/')) {
          return '/api/hls' + trimmed;
        }
        // Otherwise it's a relative path - make it relative to the proxy base path
        if (trimmed) {
          return baseProxyPath + trimmed;
        }
        return line;
      }).join('\n');
      
      body = rewritten;
      // Log for debugging (remove in production)
      if (process.env.NODE_ENV === 'development') {
        console.log(`[HLS Proxy] Rewritten playlist ${path}:`, rewritten.substring(0, 500));
      }
    } else {
      // For segment files, return as array buffer
      body = await response.arrayBuffer();
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new NextResponse('Proxy error', { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

