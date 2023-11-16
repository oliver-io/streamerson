| Test Case            | **control** (ms) | **experiment** (ms) | Base<br/>Overhead | **stream** (ms) | Stream<br/>Overhead | **iterator** (ms) | Iterator<br/>Overhead |
| :------------------- | :--------------: | :-----------------: | ----------------- | --------------- | ------------------- | ----------------- | --------------------- |
| write-100k-bulk      |       1033       |         940         | ~ -9.9%           | n/a             | n/a                 | n/a               | n/a                   |
| write-1k-iterative   |        44        |         19          | ~ -131.6%         | n/a             | n/a                 | n/a               | n/a                   |
| write-1k-bulk        |        35        |         20          | ~ -75.0%          | n/a             | n/a                 | n/a               | n/a                   |
| write-100k-iterative |       1057       |         938         | ~ -12.7%          | n/a             | n/a                 | n/a               | n/a                   |
| read-100k-bulk       |       385        |         402         | ~ 4.2%            | n/a             | n/a                 | n/a               | n/a                   |
| read-1k-iterative    |       134        |         159         | ~ 15.7%           | n/a             | n/a                 | n/a               | n/a                   |
| read-1k-bulk         |        7         |          9          | ~ 22.2%           | n/a             | n/a                 | n/a               | n/a                   |
| read-100k-iterative  |      12113       |        14866        | ~ 18.5%           | n/a             | n/a                 | n/a               | n/a                   |