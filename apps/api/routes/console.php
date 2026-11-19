<?php

use Illuminate\Support\Facades\Schedule;

Schedule::command('images:reap-stale')->everyMinute()->withoutOverlapping();
