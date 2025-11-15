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
      let text = await response.text();
      
      // Log original for debugging
      if (process.env.NODE_ENV === 'development') {
        console.log(`[HLS Proxy] Original playlist ${path}:`, text.substring(0, 500));
      }
      
      // Get the base path of the current playlist (directory path)
      const pathParts = path.split('/');
      pathParts.pop(); // Remove filename
      const basePath = pathParts.length > 0 ? pathParts.join('/') + '/' : '';
      const baseProxyPath = `/api/hls/${basePath}`;
      
      // Step 1: Rewrite absolute URLs (http://127.0.0.1:8080/...)
      text = text.replace(
        /https?:\/\/127\.0\.0\.1:8080\//g,
        '/api/hls/'
      );
      
      // Step 2: Rewrite all non-comment, non-empty lines
      const lines = text.split('\n');
      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        
        // Keep comments and empty lines as-is
        if (trimmed.startsWith('#') || trimmed === '') {
          return line;
        }
        
        // Skip if already rewritten
        if (trimmed.startsWith('/api/hls/')) {
          return line;
        }
        
        // Skip if it's an external http/https URL (not localhost)
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          return line;
        }
        
        // Handle absolute paths starting with /
        if (trimmed.startsWith('/')) {
          return '/api/hls' + trimmed;
        }
        
        // Handle relative paths
        if (trimmed) {
          return baseProxyPath + trimmed;
        }
        
        return line;
      });
      
      body = rewrittenLines.join('\n');
      
      // Log rewritten for debugging
      if (process.env.NODE_ENV === 'development') {
        console.log(`[HLS Proxy] Rewritten playlist ${path}:`, body.substring(0, 500));
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

