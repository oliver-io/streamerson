# @streamerson/benchmarking

> Reference implementations, Put To the Test

# Table of Contents:

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Benchmarking

This repo will contain a few things meant to benchmark the performance of the @streamerson modules. The general
structure will be like this:

- Prepare several different implementations of the same thing, some with @streamerson modules in the mix
- Prepare several different _deployments_ of those same things
- Run a series of benchmarks using [`gatling`](https://gatling.io/) against the deployed images _from_ another deployed
  image
- Compare the results to their peers, strictly relatively.
- Generate some graphs. Use them to improve, and/or brag, and/or understand things.

Right now I'm thinking I will build a sort of general CLI tool that takes a given use-case ("crud app") and stands it up
in

- Local (for development and baseline benchmarks)
- AWS (on EC2 with Redis hosted on ElastiCache)
- GCP (on GCE with Redis hosted on Cloud Memorystore)
- Probably That's It for Now

I'll track the current results below

## Benchmarking Results

| Implementation                           | Local | AWS | GCP |
|------------------------------------------|-------|-----|-----|
| push 1000x msg w/ one producer           |       |     |     |
| push 1000x msg w/ one standard client    |       |     |     |
| push 1000x msg w/ one producer           |       |     |     |
| push 10,000x msg w/ one standard client  |       |     |     |
| push 10,000x msg w/ one producer         |       |     |     |
| push 100,000x msg w/ one standard client |       |     |     |
| push 100,000x msg w/ one producer        |       |     |     |
| read 1000x msg w/ one cons               |       |     |     |
| read 1000x msg w/ one standard client    |       |     |     |
| read 1000x msg w/ one producer           |       |     |     |
| read 10,000x msg w/ one standard client  |       |     |     |
| read 10,000x msg w/ one producer         |       |     |     |
| read 100,000x msg w/ one standard client |       |     |     |
| read 100,000x msg w/ one producer        |       |     |     |
