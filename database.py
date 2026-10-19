from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
import config

engine = create_async_engine(config.DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
