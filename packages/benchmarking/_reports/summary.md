| Test Case            | **control** (ms) | **experiment** (ms) | Framework Overhead |
| :------------------- | :--------------: | :-----------------: | ------------------ |
| write-1k-iterative   |       112        |         112         | ~ 0.0%             |
| write-1k-bulk        |        36        |         54          | ~ 33.3%            |
| read-1k-iterative    |       104        |         113         | ~ 8.0%             |
| read-1k-bulk         |        7         |          9          | ~ 22.2%            |
| write-100k-iterative |       8359       |        8654         | ~ 3.4%             |
| write-100k-bulk      |       1061       |        2268         | ~ 53.2%            |
| read-100k-iterative  |       8598       |        9407         | ~ 8.6%             |
| read-100k-bulk       |       413        |         451         | ~ 8.4%             |