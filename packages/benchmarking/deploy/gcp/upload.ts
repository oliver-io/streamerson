export async function run(){
  const url = "https://storage.googleapis.com/streamerson-benchmarks/readbench.json?x-goog-signature=9f1060983bd1d35a465ff7c52414466187ba084121680939a3837f042b87d8a3d6c95be783c88a8cb418cd185eaeb61885b94442f18d101a62e3c3e833b7581699345a73458f76a467ca8d0d05d606f3553782b1c99b2cb79baa1a601ec09a79251fa58afec44db2d0ee257ab22a271654af3fe8226d3e4666a7b96063a58ad75f6bd75c4c4d9754a2debc2ecb7f8e92de40deaf62e26f90bee6b4c9878920bd88725cf87437ee1dc31f8ee07c5c2d80c0bd2956d13a7a8e8b05175d669a9881d671d4573a67b4cab8c99f5fff551258111d2ccb9e5b847f52c2f4f0fd22f3f6769899c33d5310aaee4f7505d798818c21cf554bfd59951d67beb22f0ea9ab08&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=admin-services%40streamerson-benchmarks.iam.gserviceaccount.com%2F20231116%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20231116T023321Z&x-goog-expires=604800&x-goog-signedheaders=host"

  if (url) {
    const body = JSON.stringify({
      hello: "world"
    });
    console.info({ url }, 'Uploading report results to the presigned destination...');
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ["Content-Type"]: 'application/json'
      },
      body
    });

    const data = await response.text();
    console.log(data);
  }
}

run().catch(console.error)
