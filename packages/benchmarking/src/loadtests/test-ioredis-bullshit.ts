import { createClient } from 'redis';
async function run() {
  console.log('Creating client')
  const connection = await createClient();
  await connection.connect();
  console.log('got client.... pinging')
  const expectedPong = await connection.ping();
  console.log('Got pong....?')
  if (expectedPong !== 'PONG') {
    throw new Error("Problem bootstrapping redis...")
  } else {
    console.log('Received ', expectedPong)
  }
  console.log('ok...?')

  try {
    return await connection.xGroupCreate(
      'teststream',
      'watgroup',
      '$',
      { MKSTREAM: true }
    );
  } catch(err) {
    console.warn(err);
  }

  const xreadParams = [
    'XREADGROUP',
    'GROUP',
    'watgroup',
    'watmember',
    'BLOCK',
    1,
    'STREAMS',
    'teststream',
    '>'
  ]

  console.log(`Issuing XREADGROUP command equivalent: "${xreadParams.join(' ')}"`);
  const xReadGroupResult = await connection.xReadGroup(
    'watgroup',
    'watmember',
    {  key: 'teststream', id: '>' },
    { BLOCK: 100, NOACK: true, COUNT: 10 }
  );

  console.log('Received XREADGROUP response...')
  console.log(xReadGroupResult);
}

run().catch(console.error);

//"xreadgroup GROUP watgroup watmember BLOCK 1 STREAMS teststreamm >
//"XREADGROUP GROUP watgroup watmember BLOCK 1 STREAMS teststream >
