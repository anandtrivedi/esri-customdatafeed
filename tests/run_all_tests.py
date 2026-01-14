#!/usr/bin/env python3
"""
Run all tests for the ArcGIS Custom Data Feed.
Tests do NOT require ArcGIS - they test core functionality.
"""

import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import unittest
from io import StringIO

def run_tests():
    """Run all unit tests and display results."""

    print("=" * 70)
    print("ArcGIS Custom Data Feed - Unit Test Suite")
    print("=" * 70)
    print()
    print("These tests verify core functionality without requiring ArcGIS.")
    print("See TESTING_STATUS.md for information about ArcGIS integration testing.")
    print()
    print("=" * 70)
    print()

    # Discover and run all tests
    loader = unittest.TestLoader()
    start_dir = os.path.dirname(__file__)
    suite = loader.discover(start_dir, pattern='test_*.py')

    # Run tests with verbose output
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # Print summary
    print()
    print("=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    print(f"Tests run: {result.testsRun}")
    print(f"Successes: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")
    print()

    if result.wasSuccessful():
        print("✅ ALL TESTS PASSED!")
        print()
        print("Next Steps:")
        print("1. Test API endpoints: python examples/test_geometry_types.py")
        print("2. Validate GeoJSON output at https://geojson.io")
        print("3. Test with ArcGIS Pro or JavaScript API")
        print()
        print("See TESTING_STATUS.md for complete testing checklist.")
        return 0
    else:
        print("❌ SOME TESTS FAILED")
        print()
        print("Please fix failing tests before proceeding.")
        print("See TESTING_STATUS.md for troubleshooting.")
        return 1


if __name__ == '__main__':
    sys.exit(run_tests())
