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
      // Rewrite absolute URLs to use proxy
      body = text.replace(
        /(https?:\/\/127\.0\.0\.1:8080\/|http:\/\/127\.0\.0\.1:8080\/)/g,
        '/api/hls/'
      );
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

