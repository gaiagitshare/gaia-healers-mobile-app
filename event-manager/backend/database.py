from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./event.db")

_IS_SQLITE = DATABASE_URL.startswith("sqlite")
# A file-backed SQLite database (not ":memory:"), which gets a real connection pool.
_SQLITE_FILE = _IS_SQLITE and DATABASE_URL not in ("sqlite://", "sqlite:///:memory:") and ":memory:" not in DATABASE_URL

_engine_kwargs = {}
if _IS_SQLITE:
    # timeout: how long a connection waits for another writer's lock (seconds)
    # before raising "database is locked", instead of failing at once.
    _engine_kwargs["connect_args"] = {"check_same_thread": False,
                                      "timeout": float(os.getenv("SQLITE_BUSY_TIMEOUT_S", "15"))}
if _SQLITE_FILE:
    # Every synchronous request holds its session from the dependency through
    # the endpoint to the teardown, and FastAPI runs those in a thread pool of
    # 40. With the default pool (5 + 10) a burst of more than 15 in-flight
    # requests left threads holding connections while waiting for a thread, and
    # threads holding the thread slots while waiting for a connection: the
    # process deadlocked for the 30 s pool timeout and, under steady traffic,
    # never recovered (audit 7 Nov 2026). A pool larger than the thread pool
    # plus the background threads cannot deadlock that way. SQLite connections
    # are cheap file handles, so a large pool costs nothing.
    _engine_kwargs.update(
        pool_size=int(os.getenv("DB_POOL_SIZE", "60")),
        max_overflow=int(os.getenv("DB_POOL_OVERFLOW", "20")),
        pool_timeout=float(os.getenv("DB_POOL_TIMEOUT_S", "10")),
    )

engine = create_engine(DATABASE_URL, **_engine_kwargs)

if _SQLITE_FILE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):
        cur = dbapi_connection.cursor()
        try:
            cur.execute("PRAGMA busy_timeout=%d" % int(float(os.getenv("SQLITE_BUSY_TIMEOUT_S", "15")) * 1000))
            # Write-ahead logging lets readers (door lookups, the app, reports)
            # carry on while one writer commits, instead of queueing behind it.
            # It is a property of the database FILE and survives restarts, and
            # a WAL database must never be copied with a plain cp (deploy.sh
            # and several tests do), so it is opt-in: SQLITE_WAL=1.
            if os.getenv("SQLITE_WAL", "0") == "1":
                cur.execute("PRAGMA journal_mode=WAL")
        finally:
            cur.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
