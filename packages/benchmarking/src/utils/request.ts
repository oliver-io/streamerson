import http from 'http';

export async function makeHTTPRequest(hostname: string, path: string = '/', method: 'GET' | 'POST' = 'GET', data?: any) {
  // const options = {
  //   headers: {
  //     'Content-Type': 'application/json',
  //   },
  //   method,
  //   body: JSON.stringify(data) ?? undefined
  // };
  //
  // if (data) {
  //   options.headers['Content-Length'] = Buffer.byteLength(options.body);
  // }

  const response = await fetch(`${hostname}${path}`, {
    headers: {
      'Content-Type': 'application/json',
    },
    method,
    body: JSON.stringify(data) ?? undefined
  });

  return await response.json();
  //
  // return await new Promise((resolve, reject) => {
  //   const postData = data ? JSON.stringify(data) : null;
  //
  //   const options = {
  //     hostname: `${hostname}${path}`,
  //     method,
  //     headers: {
  //       'Content-Type': 'application/json',
  //     }
  //   };
  //
  //   if (postData) {
  //     options.headers['Content-Length'] = Buffer.byteLength(postData);
  //   }
  //
  //   const req = http.request(hostname, options, (res) => {
  //     let body = '';
  //
  //     res.on('data', (chunk) => {
  //       body += chunk;
  //     });
  //
  //     res.on('end', () => {
  //       if (res.statusCode !== 201) {  // 201 Created is a typical response for successful POST requests
  //         reject(new Error(`Failed with status: ${res.statusCode}, ${body}`));
  //       } else {
  //         resolve(JSON.parse(body));
  //       }
  //     });
  //   });
  //
  //   req.on('error', (error) => {
  //     reject(error);
  //   });
  //
  //   if (postData) {
  //     req.write(postData);
  //   }
  //   req.end();
  // });
}
