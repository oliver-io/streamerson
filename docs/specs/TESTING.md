# Testing Philosophy

The general approach to testing in this library is an integration-test focused approach.  We eschew the need for tautological unit tests, unless the logic for a particular function is highly variadic and complicated, in which case it may deserve a unit-test of its own.

In most cases, we should test functionality simply as follows:

1) Create or use an existing test harness that instantiates an instance of our modules with as many real dependencies as possible-- i.e., instead of mocking Redis, using an in-memory version.  We trust that third-party APIs work (i.e., Redis or the Bun modules) as stated, only testing our own implementations.
2) We initiate transactions, API calls, or behavioral stimulus and observe the result.  Through this we verify the *behavior* of a module as a black-box, and assert known information about expected output.
3) When we test complicated systems that depend on user-behavior or runtime responses, we utilize *spies* to observe or stimulate interior behavior, always carefully aware of asynchronocity.  We can use the test modules to control the flow of time and assert about asynchronous events.
4) We care about contracts beyond all else, and we test mostly from the perspective of contract fulfillment.  Assertions about interior behavior should be limited to checks that are unobservable in final output (Critical side-effects, database integrity, et cetera).
5) We re-use the testing logic as a harness to perform tests, minimizing the surface area of test-specific logical failures by absorbing complicated setups into fixtures or setup modules.
6) We always make sure our tests run without pending or waiting behavior (using the clock modules to control asynchronocity) and are part of a useful feedback loop.
7) We always make sure our tests cover important, real logical surfaces instead of attmepting to create tests for the sake of coverage.
8) We always make sure our tests cover the extent of possible behavior, utilizing happy path and sad path testing, and making sure that the errors are reported and intelligble in sad paths.
9) We always make sure our modules fail-early and eagerly as opposed to covering up any kind of instability, errors, or breakage.  We never introduce silent failures to fix tests.
10) When we encounter a bug that is real, logical, and part of the implementation, we create a test that covers it.  We observe this test failing, to verify our hypotheses about the bugs.  We then fix the implementation until the test succeeds, always in that order.