| Test Case            | **control** (ms) | **experiment** (ms) | Base<br/>Overhead         | **stream** (ms) | Stream<br/>Overhead | **iterator** (ms) | Iterator<br/>Overhead |
| :------------------- | :--------------: | :-----------------: | ------------------------- | --------------- | ------------------- | ----------------- | --------------------- |
| write-1k-iterative   |        22        |         21          | ~ 4.5% :heavy_check_mark: | n/a             | n/a                 | n/a               | n/a                   |
| write-1k-bulk        |        22        |         20          | ~ 9.1% :heavy_check_mark: | n/a             | n/a                 | n/a               | n/a                   |
| write-100k-iterative |       949        |        1036         | ~ 8.4% :warning:          | n/a             | n/a                 | n/a               | n/a                   |
| write-100k-bulk      |       1028       |        1062         | ~ 3.2% :warning:          | n/a             | n/a                 | n/a               | n/a                   |
| read-1k-iterative    |       237        |         260         | ~ 8.8% :warning:          | n/a             | n/a                 | n/a               | n/a                   |
| read-1k-bulk         |        7         |          9          | ~ 22.2% :warning:         | n/a             | n/a                 | n/a               | n/a                   |
| read-100k-iterative  |      21936       |        22428        | ~ 2.2% :warning:          | n/a             | n/a                 | n/a               | n/a                   |
| read-100k-bulk       |       323        |         356         | ~ 9.3% :warning:          | n/a             | n/a                 | n/a               | n/a                   |