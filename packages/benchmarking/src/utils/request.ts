import http from 'http';

export async function makeHTTPRequest(hostname: string, path: string = '/', method: 'GET' | 'POST' = 'GET', data?: any, count: number = 0) {
  if (count > 3) {
    throw new Error("Failed to make HTTP request after 3 attempts");
  }

  try {
    const response = await fetch(`${hostname}${path}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      method,
      body: JSON.stringify(data) ?? undefined
    });

    return await response.json();
  } catch(err) {
    return makeHTTPRequest(hostname, path, method, data, count+1);
  }
}
