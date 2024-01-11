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
      'default-stream-topic::DEFAULT::CONSUMER_INCOMING',
      'wat',
      '$',
      { MKSTREAM: true }
    );
  } catch(err) {
    if (err.message && !err.message.includes('BUSYGROUP')) {
      console.error(err, 'Unrecognized error');
    }
  }

  const xreadParams = [
    'XREADGROUP',
    'GROUP',
    'watgroup',
    'watmember',
    'BLOCK',
    1000,
    'STREAMS',
    'teststream',
    '>'
  ]

  console.log(`Issuing XREADGROUP command equivalent: "${xreadParams.join(' ')}"`);
  const xReadGroupResult = await connection.xReadGroup(
    'wat',
    'wat-0',
    {  key: 'default-stream-topic::DEFAULT::CONSUMER_INCOMING', id: '>' },
    { BLOCK: 1000, NOACK: true, COUNT: 10 }
  );

  console.log('Received XREADGROUP response...')
  console.log(xReadGroupResult);
}

run().catch(console.error);

//"xreadgroup GROUP watgroup watmember BLOCK 1 STREAMS teststreamm >
//"XREADGROUP GROUP watgroup watmember BLOCK 1 STREAMS teststream >
