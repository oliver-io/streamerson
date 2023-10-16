# @streamerson/benchmarking

> Reference implementations, Put To the Test

# Table of Contents:

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Benchmarking](#benchmarking)
- [Benchmarking Results](#benchmarking-results)
  - [Local Docker](#local-docker)
  - [AWS](#aws)
  - [Google Cloud Platform (GCP)](#google-cloud-platform-gcp)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Benchmarking

This repo will contain a few things meant to benchmark the performance of the @streamerson modules. The general
structure will be like this:

- Prepare several different implementations of the same thing, some with @streamerson modules in the mix
- Prepare several different _deployments_ of those same things
- Run a series of definitions using [`gatling`](https://gatling.io/) against the deployed images _from_ another deployed
  image
- Compare the results to their peers, strictly relatively.
- Generate some graphs. Use them to improve, and/or brag, and/or understand things.

Right now I'm thinking I will build a sort of general CLI tool that takes a given use-case ("crud app") and stands it up
in

- Local (for development and baseline definitions)
- AWS (on EC2 with Redis hosted on ElastiCache)
- GCP (on GCE with Redis hosted on Cloud Memorystore)
- Probably That's It for Now

I'll track the current results below

## Benchmarking Results

### Local Docker

<details>
<summary>
  Dropdown for Benchmarking Results
</summary>

<!-- BEGIN-CODE: ./_reports/summary.md -->
[**summary.md**](./_reports/summary.md)

| Test Case            | **control** (milliseconds) | **experiment** (milliseconds) |
| :------------------- | :------------------------: | :---------------------------: |
| write-1k-iterative   |            112             |              112              |
| write-1k-bulk        |             36             |              54               |
| read-1k-iterative    |            104             |              113              |
| read-1k-bulk         |             7              |               9               |
| write-100k-iterative |            8359            |             8654              |
| write-100k-bulk      |            1061            |             2268              |
| read-100k-iterative  |            8598            |             9407              |
| read-100k-bulk       |            413             |              451              |

<!-- END-CODE: ./_reports/summary.md -->

</details>

### AWS

<details>
<summary>
  Dropdown for Benchmarking Results
</summary>

```
N/A
```

</details>


### Google Cloud Platform (GCP)


<details>
<summary>
  Dropdown for Benchmarking Results
</summary>

```pre
N/A
```

</details>

